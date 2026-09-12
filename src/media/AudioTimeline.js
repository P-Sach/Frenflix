/**
 * AudioTimeline — where the sound *actually is*.
 *
 * The problem this solves
 * ----------------------
 * Locking a video element to an audio element by comparing their
 * `currentTime` values aligns the two decoders. It does not align what the
 * viewer sees with what the viewer hears, because `currentTime` describes
 * audio that has been handed to the output, not audio that has come out of it.
 * Everything after that hand-off — the mixer buffer, the device buffer, a
 * Bluetooth link — is dead time that no amount of element-to-element
 * arithmetic can see. Measured in Chrome on an ordinary wired Windows machine
 * that dead time is 64 ms; on Bluetooth it is routinely 150–300 ms.
 *
 * The previous version tried to cover this by reading `outputLatency` off a
 * fresh AudioContext. That does not work, for two reasons that only show up
 * when you measure it:
 *
 *   1. `outputLatency` is 0 until the context has actually pushed audio, so
 *      the read fell through to `baseLatency` — the render quantum, about
 *      10 ms, a completely unrelated quantity that is the same on every
 *      machine and tells you nothing about the output path.
 *   2. It was then *added* to the video's position, pushing the picture
 *      further ahead of the sound. The correction has to go the other way:
 *      if the sound comes out late, the picture has to be held back.
 *
 * The approach here
 * -----------------
 * Route the audio element through a Web Audio graph. That sounds like a
 * bigger hammer than the problem needs, and it is not: once the element feeds
 * a graph, `AudioContext.getOutputTimestamp()` reports a matched pair of
 * (context time, performance.now()) for the sample *leaving the hardware*.
 * The output path stops being an unknown and becomes a measured quantity, and
 * the question "what will the listener be hearing at the instant this video
 * frame is on screen?" gets an exact answer.
 *
 * Verified before relying on it: element `volume` and `muted` still apply
 * through the tap (a 0.25 volume gives exactly 0.25 amplitude in the graph,
 * muting gives silence), so the ordinary controls keep working untouched.
 *
 * If anything about that path is unavailable — no Web Audio, a context that
 * will not start, a cross-origin source Chrome refuses to tap — the class
 * falls back to modelling `currentTime` and applying whatever `outputLatency`
 * a bare context reports. Worse, but never silent: the tap is only ever
 * created after the context is confirmed running, because a tapped element
 * feeding a suspended graph produces no sound at all.
 */

import { MediaClock } from './MediaClock.js';

/** How long a getOutputTimestamp() reading is reused before refreshing. */
const TIMESTAMP_TTL_MS = 100;
/** Smoothing on the measured output-path length. It is hardware; it is steady. */
const LAG_SMOOTHING = 0.25;
/**
 * Ceiling on the output path, seconds.
 *
 * This number moves the picture, so a wild reading would be visible as badly
 * broken sync with no obvious cause. Wired outputs sit near 60 ms and the worst
 * Bluetooth codecs reach about 400; anything past this is not a latency, it is
 * a bad reading, and the manual mode exists for the case where the hardware
 * lies about it.
 */
const MAX_LAG = 0.6;
/** Window for the render-clock anchor. Long enough to span several
 *  `currentTime` update quanta, short enough to follow a rate change. */
const ANCHOR_WINDOW_MS = 400;

export const TimelineMode = {
  /** Element routed through Web Audio; the output path is measured. */
  GRAPH: 'graph',
  /** No tap; `currentTime` modelled and `outputLatency` applied as a constant. */
  ESTIMATED: 'estimated',
};

export class AudioTimeline extends EventTarget {
  /**
   * @param {HTMLMediaElement} el the element carrying the sound
   */
  constructor(el) {
    super();
    this.el = el;
    this.ctx = null;
    this.source = null;
    this.mode = TimelineMode.ESTIMATED;
    /** Whether a tap should be attempted at all. */
    this.wantTap = true;
    /** Reported output latency of the context, seconds. 0 until it is real. */
    this.reportedLatency = 0;
    /** Last failure, for the diagnostics panel. */
    this.note = '';

    this._clock = new MediaClock(el, { windowMs: ANCHOR_WINDOW_MS });
    this._anchors = [];      // {perf, value} where value = elPos - rate*ctxNow
    this._ts = null;         // cached getOutputTimestamp()
    this._tsAt = 0;
    this._lag = 0;           // measured render-to-audible gap, seconds
    this._rate = 1;
    this._onStateChange = () => this._pumpContext();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Bring the audio clock up. Must be called from a user gesture, which is
   * why the controller calls it at the top of `play()`: an AudioContext
   * created outside one starts suspended, and a tapped element feeding a
   * suspended context is silent.
   *
   * @param {{tap?: boolean}} [opts]
   * @returns {Promise<string>} the mode actually achieved
   */
  async arm({ tap = this.wantTap } = {}) {
    this.wantTap = tap;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      this.note = 'no Web Audio in this browser';
      return this.mode;
    }
    if (!this.ctx) {
      try {
        this.ctx = new Ctx({ latencyHint: 'interactive' });
        this.ctx.addEventListener?.('statechange', this._onStateChange);
      } catch {
        this.note = 'could not create an AudioContext';
        return this.mode;
      }
    }
    await this._pumpContext();

    // Only tap a context that is confirmed running. A tap into a suspended
    // graph means no sound at all, which is far worse than a coarse clock.
    if (tap && !this.source && this.ctx.state === 'running') this._tap();
    if (!tap && !this.source) this.note = 'precise clock switched off';
    this._readLatency();
    return this.mode;
  }

  async _pumpContext() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
      try { await this.ctx.resume(); } catch { /* needs another gesture */ }
    }
  }

  _tap() {
    try {
      this.source = this.ctx.createMediaElementSource(this.el);
      // Straight through: volume and mute are applied by the element upstream
      // of this node, so no gain stage is needed and none is added.
      this.source.connect(this.ctx.destination);
      this.mode = TimelineMode.GRAPH;
      this.note = '';
      this.dispatchEvent(new Event('modechange'));
    } catch (err) {
      // Already tapped, or a source Chrome will not expose (cross-origin).
      this.source = null;
      this.mode = TimelineMode.ESTIMATED;
      this.note = `output path not measurable (${err?.name || 'error'})`;
    }
  }

  /**
   * Adopt a tap somebody else already created on this element.
   * `createMediaElementSource` may only be called once per element, so a test
   * harness (or any other code) that got there first hands its node over here
   * rather than leaving both sides broken.
   */
  adoptSource(node) {
    if (this.source || !node) return false;
    this.source = node;
    this.ctx = node.context;
    this.mode = TimelineMode.GRAPH;
    return true;
  }

  dispose() {
    this.ctx?.removeEventListener?.('statechange', this._onStateChange);
    // Closing silences a tapped element permanently, so this only happens when
    // the element itself is going away. It has to happen then, though: a page
    // that walks through ten titles would otherwise leave ten live audio
    // contexts behind, and browsers cap how many one page may hold.
    try { this.ctx?.close?.(); } catch { /* already closed */ }
    this.ctx = null;
    this.source = null;
  }

  // ------------------------------------------------------------------ reading

  _readLatency() {
    if (!this.ctx) return;
    const l = this.ctx.outputLatency;
    // baseLatency is NOT a fallback for this. It is the render quantum and has
    // nothing to do with the output path; taking it was the original bug.
    if (Number.isFinite(l) && l > 0 && l < MAX_LAG) this.reportedLatency = l;
  }

  _timestamp() {
    if (!this.ctx) return null;
    const now = performance.now();
    if (this._ts && now - this._tsAt < TIMESTAMP_TTL_MS) return this._ts;
    let ts = null;
    try { ts = this.ctx.getOutputTimestamp(); } catch { ts = null; }
    if (!ts || !(ts.contextTime > 0) || !(ts.performanceTime > 0)) return this._ts;
    // Read the render clock in the SAME task as the timestamp. Comparing a
    // fresh `currentTime` against a cached `contextTime` measures how stale
    // the cache is, not how long the output path is — that mistake had this
    // reporting a 232 ms output path on hardware that has 64 ms of it, and
    // pre-positioning the picture by the difference on every start.
    const gap = this.ctx.currentTime - ts.contextTime;
    if (gap > 0 && gap < MAX_LAG) {
      this._lag = this._lag > 0 ? this._lag + (gap - this._lag) * LAG_SMOOTHING : gap;
    }
    this._ts = ts;
    this._tsAt = now;
    this._readLatency();
    return ts;
  }

  /**
   * How far behind the sound is: the gap between audio that has been rendered
   * and audio that has come out of the speakers, in seconds of wall time.
   * This is the number the picture has to be held back by.
   */
  get lagSeconds() {
    if (this.mode === TimelineMode.GRAPH && this.ctx) {
      this._timestamp();
      if (this._lag > 0) return this._lag;
    }
    return this.reportedLatency;
  }

  /** True when the lag above is measured rather than guessed. */
  get measured() {
    return this.mode === TimelineMode.GRAPH && Boolean(this._ts);
  }

  reset() {
    this._clock.reset();
    this._anchors.length = 0;
    // The measured output path is a property of the hardware, not of this
    // playback run, so it deliberately survives a seek or a source change.
  }

  /**
   * Record one observation. Cheap, call it often — the controller does so on
   * every tick and every presented video frame.
   */
  sample(now = performance.now(), rate = this._rate) {
    this._rate = rate || 1;
    this._clock.sample(now);
    if (this.mode !== TimelineMode.GRAPH || !this.ctx) return;
    const pos = this.el.currentTime;
    if (!Number.isFinite(pos)) return;
    // `currentTime` lags the truth and the render clock does not, so the
    // offset between them is only ever under-reported; the upper envelope of
    // recent readings is the best estimate of the real one.
    this._anchors.push({ perf: now, value: pos - this._rate * this.ctx.currentTime });
    const cutoff = now - ANCHOR_WINDOW_MS;
    while (this._anchors.length > 1 && this._anchors[0].perf < cutoff) this._anchors.shift();
  }

  /**
   * The audio content position a listener is hearing at wall-clock instant
   * `wallMs` (a `performance.now()` value, which may be slightly in the
   * future — `requestVideoFrameCallback` hands over the instant a frame will
   * be *displayed*, and that is the instant worth aligning to).
   *
   * @returns {number|null} seconds of content, or null if not yet knowable
   */
  positionAt(wallMs, rate = this._rate) {
    this._rate = rate || 1;
    if (this.mode === TimelineMode.GRAPH && this.ctx && this._anchors.length) {
      const ts = this._timestamp();
      if (ts) {
        let anchor = -Infinity;
        for (let i = 0; i < this._anchors.length; i += 1) {
          if (this._anchors[i].value > anchor) anchor = this._anchors[i].value;
        }
        // Context time of the sound leaving the hardware at wallMs.
        const audibleCtxTime = ts.contextTime + (wallMs - ts.performanceTime) / 1000;
        return anchor + this._rate * audibleCtxTime;
      }
    }
    if (!this._clock.hasHistory) return null;
    // Fallback: model `currentTime` and subtract whatever the output path is
    // reported to cost. In media-time terms that scales with playback rate.
    return this._clock.estimate(wallMs) - this.reportedLatency * this._rate;
  }

  get hasHistory() {
    return this.mode === TimelineMode.GRAPH ? this._anchors.length > 0 : this._clock.hasHistory;
  }
}

export default AudioTimeline;
