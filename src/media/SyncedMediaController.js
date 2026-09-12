import { AudioTimeline } from './AudioTimeline.js';
import { MediaClock } from './MediaClock.js';

/**
 * SyncedMediaController — keeps a separately-sourced <audio> element and a
 * <video> element playing as one.
 *
 * Architecture, and why it changed
 * -------------------------------
 * The first version made the *video* the master and bent the audio's
 * playbackRate to follow. That is backwards, and every serious player agrees.
 * VLC's clock design uses the audio output as the master clock for local
 * playback and makes the video a slave that queries it; the reason is
 * perceptual, not technical — a few percent of speed change on audio is a
 * pitch and timbre artefact the ear notices immediately, while the same change
 * on video is invisible, and a dropped or repeated frame is far cheaper than an
 * audible glitch.
 *
 * So here:
 *   - AUDIO is the master. It runs at exactly the user's chosen rate, is never
 *     resampled, and is never seeked to chase the video.
 *   - VIDEO is the slave. It is muted whenever an external audio track is in
 *     use, which makes its playbackRate free to bend — no one can hear a muted
 *     element being sped up 4%.
 *
 * How the error is measured
 * -------------------------
 * Not by comparing `currentTime` on both elements. That reads two lagging step
 * functions against each other and mostly measures quantisation noise (see
 * MediaClock). Instead:
 *   - the audio position comes from a smoothed clock model, and
 *   - the video position comes from `requestVideoFrameCallback`, whose
 *     `mediaTime` is the presentation timestamp of the frame *actually being
 *     displayed*, and whose `expectedDisplayTime` says when it will be on
 *     screen.
 * Comparing "the frame about to be shown" against "where the audio will be at
 * that instant" is the real question, and it is answerable to a few
 * milliseconds. `currentTime` polling never was.
 */

// Correction thresholds, seconds.
const DEADBAND = 0.006;      // ~a fifth of a frame at 30fps; below this, leave it alone
const RESEEK_LIMIT = 0.25;   // beyond this, rate correction would take too long — jump
const MAX_RATE_TRIM = 0.10;  // video only, and muted, so 10% is free
const RATE_GAIN = 1.6;       // proportional gain from drift to rate trim
/**
 * Integral gain, and why there is one at all.
 *
 * The video and audio pipelines are separate clock domains and they do not run
 * at exactly the same effective speed. Against a constant rate mismatch a
 * purely proportional controller cannot settle at zero — it settles wherever
 * the correction it produces happens to cancel the mismatch, which is a
 * permanent offset that grows with the mismatch. Measured on a 9s clip that
 * showed up as a steady ~1.5ms/s slope in the error.
 *
 * The integral term accumulates that bias and holds it, so the loop *learns*
 * the ratio between the two clocks instead of fighting it every frame. It is
 * deliberately slow: it should track a hardware constant, not chase jitter.
 */
const INTEGRAL_GAIN = 0.35;
const MAX_BIAS = 0.03;       // the learned ratio should never need more than 3%
const TICK_MS = 100;
/** Smoothing on the reported error. Diagnostics only; the loop uses the raw value. */
const ERROR_SMOOTHING = 0.2;
const READY_ENOUGH = 3;      // HAVE_FUTURE_DATA

export class SyncedMediaController extends EventTarget {
  constructor(videoEl, audioEl) {
    super();
    this.video = videoEl;
    this.audio = audioEl;

    this.hasExternalAudio = false;
    this.wantPlay = false;
    this.stalled = false;

    /**
     * How much later the audio should sit relative to the video, in seconds.
     * Same sense as VLC's audio desync (its j/k keys): positive delays audio.
     * Total applied offset = this + the measured hardware output latency.
     */
    this.userOffset = 0;

    /**
     * auto   — hold the picture back by the measured output path (the default;
     *          the only mode where what you see matches what you hear)
     * manual — ignore the measured path; only the user's own delay applies
     * off    — no correction at all, for comparing against
     */
    this.syncMode = 'auto';

    this._rate = 1;
    this._hasStarted = false;
    this._settleArmed = false;
    this._destroyed = false;
    this._timer = null;
    this._rvfc = null;
    this._resyncPending = false;
    this._resyncStartedAt = 0;
    /** learned rate ratio between the two clock domains (integral term) */
    this._rateBias = 0;
    this._lastCorrectionAt = 0;

    /**
     * Diagnostics the bench traces. `_errorFilt` is a smoothed error — the raw
     * per-frame figure is noisy enough that reading a trend off it by eye is
     * guesswork — and `_phase` names what the loop is actually doing, which is
     * the difference between "20 ms out because it is still starting" and
     * "20 ms out while running", two very different things.
     */
    this.lastError = 0;
    this._errorFilt = 0;
    this._phase = 'idle';
    /** Hard re-seeks of the picture. A climbing count means the rate loop is
     *  not keeping up and something upstream is wrong. */
    this.seekCount = 0;

    /** rolling diagnostics */
    this.lastDrift = 0;
    this.peakDrift = 0;
    this._driftHistory = [];

    /**
     * Where the sound actually is — not where the audio element says it has
     * got to. See AudioTimeline: `currentTime` describes audio handed to the
     * output, and everything after that hand-off (mixer, device buffer,
     * Bluetooth) is dead time that element-to-element arithmetic cannot see.
     */
    this.timeline = new AudioTimeline(this.audio);
    this.videoClock = new MediaClock(this.video);

    this._onVideoReadyish = () => this._reconcile();
    this._onAudioReadyish = () => this._reconcile();
    this._onSeeking = () => { this.timeline.reset(); this.videoClock.reset(); };
    this._onSeeked = () => { this.timeline.reset(); this.videoClock.reset(); this._reconcile(); };
    this._onVideoSeeked = () => { this._resyncPending = false; this.videoClock.reset(); };
    this._onEnded = () => { this.wantPlay = false; this._pauseBoth(); this.dispatchEvent(new Event('ended')); };

    for (const type of ['canplay', 'canplaythrough', 'loadeddata', 'playing']) {
      this.video.addEventListener(type, this._onVideoReadyish);
      this.audio.addEventListener(type, this._onAudioReadyish);
    }
    this.video.addEventListener('waiting', this._onVideoReadyish);
    this.video.addEventListener('stalled', this._onVideoReadyish);
    this.audio.addEventListener('waiting', this._onAudioReadyish);
    this.audio.addEventListener('stalled', this._onAudioReadyish);
    this.audio.addEventListener('seeking', this._onSeeking);
    this.audio.addEventListener('seeked', this._onSeeked);
    this.video.addEventListener('seeked', this._onVideoSeeked);
    this.audio.addEventListener('ended', this._onEnded);
    this.video.addEventListener('ended', this._onEnded);

    if ('preservesPitch' in this.audio) this.audio.preservesPitch = true;
  }

  // ------------------------------------------------------------------ setup

  /**
   * Seconds of automatic compensation, negative because the picture is held
   * *back* to meet sound that comes out late. Zero unless the mode is auto.
   */
  get autoOffset() {
    return this.syncMode === 'auto' ? -this.timeline.lagSeconds : 0;
  }

  /** What is actually applied: the user's nudge plus the automatic part. */
  get effectiveOffset() {
    return this.userOffset + this.autoOffset;
  }

  setSources({ videoUrl, audioUrl = null }) {
    this.wantPlay = false;
    this.stalled = false;
    this._hasStarted = false;
    this._resyncPending = false;
    this.hasExternalAudio = Boolean(audioUrl);
    this.peakDrift = 0;
    this._driftHistory.length = 0;
    this._rateBias = 0;
    this.timeline.reset();
    this.videoClock.reset();

    const carrier = this.hasExternalAudio ? this.audio : this.video;
    const vol = carrier.volume;
    const muted = carrier.muted;

    // "metadata" is the default and it is a trap: a paused element that has
    // only fetched metadata never fetches another byte.
    this.video.preload = 'auto';
    this.audio.preload = 'auto';

    this.video.src = videoUrl || '';
    if (audioUrl) {
      this.audio.src = audioUrl;
      this.video.muted = true;   // the video's own track is not what we're playing
      this.audio.muted = muted;
      this.audio.volume = vol;
    } else {
      this.audio.removeAttribute('src');
      this.audio.load();
      this.video.muted = muted;
      this.video.volume = vol;
    }
    this.video.playbackRate = this._rate;
    this.audio.playbackRate = this._rate;
    this.userOffset = 0;
  }

  /**
   * Change the audio track mid-playback, without disturbing the picture.
   *
   * The viewer is looking at the video, so the video must not flicker, reload
   * or seek — only the audio element is rebuilt. Two details matter:
   *
   *   - The new position is taken from the **video**, not from `master`. The
   *     master *is* the audio, and it is the thing being replaced, so reading
   *     the position from it would read the new track's zero.
   *   - The audio is lined up and the seek confirmed *before* playback resumes.
   *     `_playBoth` pre-positions the video against `audio.currentTime`, so
   *     restarting with the new track still at 0 would yank the video back to
   *     the beginning — which is exactly the bug this ordering avoids.
   *
   * @param {string|null} url null returns to the video's own embedded track.
   */
  async swapAudio(url) {
    const resume = this.wantPlay;
    const at = this.video.currentTime;
    const vol = this.soundElement.volume;
    const muted = this.soundElement.muted;

    this.wantPlay = false;
    this._pauseBoth();
    this._hasStarted = false;
    this._rateBias = 0;
    this.timeline.reset();
    this.videoClock.reset();

    if (!url) {
      this.hasExternalAudio = false;
      this.audio.removeAttribute('src');
      this.audio.load();
      this.video.muted = muted;
      this.video.volume = vol;
    } else {
      this.hasExternalAudio = true;
      this.audio.preload = 'auto';
      this.audio.src = url;
      this.audio.playbackRate = this._rate;
      this.video.muted = true;
      this.audio.muted = muted;
      this.audio.volume = vol;

      // currentTime cannot be set before the new track has metadata.
      await this._once(this.audio, 'loadedmetadata', 8000);
      const target = Math.max(0, at - this.effectiveOffset);
      if (Number.isFinite(target) && Math.abs(this.audio.currentTime - target) > DEADBAND) {
        this.audio.currentTime = target;
        await this._once(this.audio, 'seeked', 4000);
      }
    }

    this.dispatchEvent(new Event('audiotrackchange'));
    if (resume) await this.play();
  }

  /** Resolve on the next `type` from `el`, or on timeout — never hang a swap. */
  _once(el, type, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener(type, finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      el.addEventListener(type, finish, { once: true });
    });
  }

  /** The element carrying sound, and the master clock when external audio is used. */
  get soundElement() {
    return this.hasExternalAudio ? this.audio : this.video;
  }

  get master() {
    return this.hasExternalAudio ? this.audio : this.video;
  }

  // -------------------------------------------------------------- transport

  async play() {
    // Arm the audio graph here and nowhere else: an AudioContext created
    // outside a user gesture starts suspended, and an element tapped into a
    // suspended graph is silent. play() is the gesture.
    if (this.hasExternalAudio) {
      try { await this.timeline.arm(); } catch { /* falls back to the modelled clock */ }
    }
    this.wantPlay = true;
    this._hasStarted = false;
    this._settleArmed = true;
    this._startLoops();
    return this._reconcile();
  }

  pause() {
    this.wantPlay = false;
    this.stalled = false;
    this._hasStarted = false;
    this._settleArmed = false;
    this._pauseBoth();
    this.timeline.reset();
    this.videoClock.reset();
  }

  seek(time) {
    const t = Math.max(0, time);
    this.timeline.reset();
    this.videoClock.reset();
    // Re-align explicitly once both sides land, rather than letting the loop
    // walk the error down from wherever the two seeks happened to finish.
    this._settleArmed = true;
    this._hasStarted = false;
    if (this.hasExternalAudio) {
      this.audio.currentTime = t;
      this.video.currentTime = t + this.effectiveOffset;
    } else {
      this.video.currentTime = t;
    }
  }

  get rate() { return this._rate; }

  set rate(r) {
    this._rate = r || 1;
    // The learned ratio is expressed relative to the current rate, so it does
    // not carry across a rate change.
    this._rateBias = 0;
    this._lastCorrectionAt = 0;
    // The master runs at exactly the requested rate; the slave gets the trim
    // applied on top of it by the correction loop.
    this.audio.playbackRate = this._rate;
    this.video.playbackRate = this._rate;
    this.timeline.reset();
    this.videoClock.reset();
  }

  /** Position of the master clock — what the timeline should show. */
  get currentTime() {
    return this.master.currentTime;
  }

  // ----------------------------------------------------------------- engine

  _startLoops() {
    if (!this._timer) this._timer = setInterval(() => this._tick(), TICK_MS);
    this._startFrameLoop();
  }

  _stopLoops() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._rvfc != null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._rvfc);
      this._rvfc = null;
    }
  }

  get supportsFrameCallback() {
    return typeof this.video.requestVideoFrameCallback === 'function';
  }

  _startFrameLoop() {
    if (!this.supportsFrameCallback || this._rvfc != null) return;
    const onFrame = (now, metadata) => {
      this._rvfc = this.video.requestVideoFrameCallback(onFrame);
      this._onVideoFrame(now, metadata);
    };
    this._rvfc = this.video.requestVideoFrameCallback(onFrame);
  }

  _ready(el) {
    return el.readyState >= READY_ENOUGH;
  }

  _reconcile() {
    if (this._destroyed) return undefined;

    if (!this.wantPlay) {
      this._phase = 'idle';
      this._pauseBoth();
      return undefined;
    }

    if (this.syncMode === 'off') this._phase = 'off';
    else if (this.video.seeking || this.audio.seeking) this._phase = 'seeking';

    // A lone <video> manages its own buffering and has nothing to sync with.
    if (!this.hasExternalAudio) {
      this._playBoth();
      return undefined;
    }

    const videoReady = this._ready(this.video);
    const audioReady = this._ready(this.audio);

    // Until playback has genuinely begun, hand the problem to the browser.
    // `play()` on an unbuffered element means "start as soon as you can".
    // Gating the *start* on readyState deadlocks: a paused element never
    // buffers, so it can never become ready and playback never starts.
    if (!this._hasStarted) {
      if (this._phase !== 'off') this._phase = 'starting';
      if (videoReady && audioReady && !this.video.paused && !this.audio.paused) {
        this._hasStarted = true;
        if (this._phase !== 'off') this._phase = 'running';
        if (this._settleArmed) {
          this._settleArmed = false;
          // The offset was already applied while paused, so this only catches
          // a start that went genuinely wrong. Small gaps are the loop's job.
          this._alignVideoNow(0.1);
        }
      }
      this._playBoth();
      return undefined;
    }

    if (videoReady && audioReady) {
      if (this.stalled) {
        this.stalled = false;
        this.dispatchEvent(new Event('resumed'));
      }
      if (this._phase !== 'off' && !this.video.seeking && !this.audio.seeking) this._phase = 'running';
      this._playBoth();
      return undefined;
    }

    // One side ran short of data. Hold them together rather than letting the
    // ready one run on. (VLC does the same thing: delay the others rather than
    // race the one that fell behind.)
    if (this._phase !== 'off') this._phase = 'stalled';
    if (!this.stalled && !this._resyncPending) {
      this.stalled = true;
      this.dispatchEvent(new Event('stalled'));
    }
    this._pauseBoth();
    return undefined;
  }

  async _playBoth() {
    const startAudio = this.hasExternalAudio && this.audio.paused;
    const startVideo = this.video.paused;
    if (!startAudio && !startVideo) return;

    // Pre-position the video BEFORE either element starts.
    //
    // The video has to sit `effectiveOffset` ahead of the audio, and that
    // offset used to be applied by seeking just after playback began. Seeking a
    // running decoder flushes and refills it — a stall that hits the video
    // only, which is seen as "the video starts late". While both are still
    // paused the same seek is free, and nobody is watching yet.
    if (this.hasExternalAudio && startAudio && startVideo) {
      // Only worth a seek if the offset is big enough to matter — a typical
      // wired output is ~10ms, which the rate controller absorbs in a third of
      // a second with nothing to see. Bluetooth's 150-300ms is worth the seek,
      // and it is free here because playback has not started.
      const target = this.audio.currentTime + this.effectiveOffset;
      if (Number.isFinite(target) && target >= 0
        && Math.abs(this.video.currentTime - target) > 0.03) {
        this.video.currentTime = target;
      }
    }

    // Issue both play() calls in the same task and await them together.
    // Awaiting the audio first serialised the start: the audio was already
    // running by the time the video was even asked to play.
    const pending = [];
    if (startAudio) {
      this.timeline.reset();
      pending.push(this.audio.play().catch(() => { /* superseded */ }));
    }
    if (startVideo) {
      this.videoClock.reset();
      pending.push(this.video.play().catch(() => { /* superseded */ }));
    }
    await Promise.all(pending);
  }

  _pauseBoth() {
    if (!this.video.paused) this.video.pause();
    if (this.hasExternalAudio && !this.audio.paused) this.audio.pause();
    if (this.video.playbackRate !== this._rate) this.video.playbackRate = this._rate;
  }

  /**
   * Put the video where the audio says it should be, right now — by seeking.
   *
   * `minGap` exists because a seek on a playing element is expensive and
   * visible: it flushes the decoder and stalls the picture. Anything the rate
   * controller can absorb within about a second should be left to it, so this
   * is for genuine breaks only, not for fine adjustment.
   */
  /**
   * The content position the picture should be showing at wall instant `at`.
   *
   * In auto this is where the sound *is audible*, which is what the eye has to
   * match. Manual deliberately ignores the measured output path — it aligns to
   * the rendered position instead, which is why manual sits a whole output
   * path out and why that is the correct behaviour for it: the user has said
   * they will do the aligning.
   *
   * @returns {number|null} null while the timeline has nothing to go on yet
   */
  _targetAudioAt(at) {
    const audible = this.timeline.positionAt(at, this._rate);
    if (audible == null || !Number.isFinite(audible)) return null;
    const base = this.syncMode === 'manual'
      ? audible + this.timeline.lagSeconds * this._rate
      : audible;
    return base + this.userOffset;
  }

  _alignVideoNow(minGap = DEADBAND) {
    if (!this.hasExternalAudio) return;
    const target = this._targetAudioAt(performance.now())
      ?? (this.audio.currentTime + this.effectiveOffset);
    if (!Number.isFinite(target) || target < 0) return;
    if (Math.abs(this.video.currentTime - target) < minGap) return;
    // Never stack a seek on one still in flight: seeking drops readyState, the
    // readiness gate reads that as buffering, and an unguarded resync on the
    // way back out becomes a loop that never plays.
    if (this._resyncPending && Date.now() - this._resyncStartedAt < 1500) return;
    this._resyncPending = true;
    this._resyncStartedAt = Date.now();
    this.seekCount = (this.seekCount || 0) + 1;
    this.video.playbackRate = this._rate;
    this.video.currentTime = target;
    this.videoClock.reset();
  }

  /** Sample the clocks and mind the buffering gate. */
  _tick() {
    if (this._destroyed) return;
    const now = performance.now();
    if (this.hasExternalAudio && !this.audio.paused) this.timeline.sample(now, this._rate);
    if (!this.video.paused) this.videoClock.sample(now);

    this._reconcile();

    // Fallback path for browsers without requestVideoFrameCallback: the same
    // correction, driven off the coarser clock estimate.
    if (!this.supportsFrameCallback && this._canCorrect()) {
      const target = this._targetAudioAt(now);
      if (target != null) this._correct(this.videoClock.estimate(now) - target);
    }
  }

  _canCorrect() {
    if (this.syncMode === 'off') return false;
    return this.hasExternalAudio
      && this._hasStarted
      && !this.stalled
      && !this._resyncPending
      && !this.video.paused
      && !this.audio.paused
      && !this.video.seeking
      && !this.audio.seeking
      && this.timeline.hasHistory;
  }

  /**
   * Called once per presented video frame. `metadata.mediaTime` is the exact
   * timestamp of the frame going on screen and `metadata.expectedDisplayTime`
   * is when it gets there — so we compare the frame the viewer is about to see
   * against where the audio will be at that same instant.
   */
  _onVideoFrame(now, metadata) {
    if (this._destroyed) return;
    this.timeline.sample(now, this._rate);
    if (!this._canCorrect()) return;

    const displayAt = Number.isFinite(metadata?.expectedDisplayTime)
      ? metadata.expectedDisplayTime
      : now;
    const target = this._targetAudioAt(displayAt);
    if (target == null) return;
    const videoAtDisplay = Number.isFinite(metadata?.mediaTime)
      ? metadata.mediaTime
      : this.video.currentTime;

    this._correct(videoAtDisplay - target);
  }

  /**
   * Positive drift = the video is ahead of the audio.
   * The video is muted, so slowing or speeding it is inaudible; that is the
   * whole reason the master/slave roles are this way round.
   */
  _correct(drift) {
    if (!Number.isFinite(drift)) return;

    this.lastDrift = drift;
    this.lastError = drift;
    this._errorFilt = this._driftHistory.length
      ? this._errorFilt + (drift - this._errorFilt) * ERROR_SMOOTHING
      : drift;
    this._driftHistory.push(Math.abs(drift));
    if (this._driftHistory.length > 200) this._driftHistory.shift();
    if (Math.abs(drift) > this.peakDrift) this.peakDrift = Math.abs(drift);

    const magnitude = Math.abs(drift);
    const now = performance.now();
    const dt = this._lastCorrectionAt ? Math.min(0.25, (now - this._lastCorrectionAt) / 1000) : 0;
    this._lastCorrectionAt = now;

    if (magnitude > RESEEK_LIMIT) {
      this._alignVideoNow();
      this._rateBias = 0;
      this.dispatchEvent(new CustomEvent('resync', { detail: { drift, mode: 'seek' } }));
      return;
    }

    // Integral: learn the standing rate difference between the two pipelines.
    // Frozen inside the deadband so it doesn't wander on measurement noise.
    if (dt > 0 && magnitude > DEADBAND) {
      this._rateBias = Math.max(-MAX_BIAS, Math.min(MAX_BIAS,
        this._rateBias - drift * INTEGRAL_GAIN * dt));
    }

    // Proportional gain divides by rate because the error closes at
    // rate x trim: at 1.5x the same trim corrects half again as fast, and
    // without this the loop over-corrects and rings at higher speeds.
    const proportional = (-drift * RATE_GAIN) / this._rate;
    const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, proportional + this._rateBias));
    const target = this._rate * (1 + trim);
    if (Math.abs(this.video.playbackRate - target) > 0.0005) this.video.playbackRate = target;
  }

  /** 95th percentile of recent absolute error, seconds. */
  get p95Drift() {
    if (this._driftHistory.length < 5) return 0;
    const sorted = [...this._driftHistory].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }

  /**
   * Everything the sync panel and the benches read.
   *
   * `clock: 'measured'` is the one that matters — it says the output path is a
   * measurement from the audio hardware rather than a guess, which is the
   * whole difference between the picture matching the sound and merely
   * matching the other decoder.
   */
  get syncStatus() {
    const p95Ms = this.p95Drift * 1000;
    let state;
    if (this.syncMode === 'off') state = 'off';
    else if (!this._hasStarted || this._driftHistory.length < 5) state = 'tracking';
    else if (p95Ms < 10) state = 'locked';
    else if (p95Ms < 45) state = 'tracking';
    else state = 'correcting';

    return {
      state,
      mode: this.syncMode,
      clock: this.timeline.measured ? 'measured' : 'estimated',
      clockMode: this.timeline.mode,
      clockNote: this.timeline.note,
      latencyMs: this.timeline.lagSeconds * 1000,
      // `errorMs` is the instantaneous error and `p95Ms` the recent spread.
      // They answer different questions: after a deliberate offset change the
      // p95 still carries the step itself for seconds, so only the error says
      // whether the new offset has landed.
      errorMs: this.lastDrift * 1000,
      driftMs: this.lastDrift * 1000,
      p95Ms,
      phase: this._phase,
      filteredErrorMs: this._errorFilt * 1000,
      peakMs: this.peakDrift * 1000,
      userOffsetMs: this.userOffset * 1000,
      autoOffsetMs: this.autoOffset * 1000,
      totalOffsetMs: this.effectiveOffset * 1000,
      trimPercent: ((this.video.playbackRate / (this._rate || 1)) - 1) * 100,
      biasPercent: this.rateBiasPercent,
      seeks: this.seekCount || 0,
    };
  }

  /** Switching mode re-aligns immediately: the offset it applies just changed. */
  setSyncMode(mode) {
    if (!['auto', 'manual', 'off'].includes(mode) || mode === this.syncMode) return;
    this.syncMode = mode;
    this._rateBias = 0;
    this._driftHistory.length = 0;
    this.peakDrift = 0;
    if (mode === 'off') this.video.playbackRate = this._rate;
    else this._alignVideoNow(0.05);
    this.dispatchEvent(new Event('syncmodechange'));
  }

  /** Signed A/V error in seconds. Positive: video ahead of audio. */
  get drift() {
    return this.hasExternalAudio ? this.lastDrift : 0;
  }

  /** The learned clock-ratio correction, as a percentage. Diagnostics only. */
  get rateBiasPercent() {
    return this._rateBias * 100;
  }

  /** Mean absolute error over the recent window, for the diagnostics readout. */
  get meanAbsDrift() {
    if (!this._driftHistory.length) return 0;
    let sum = 0;
    for (const d of this._driftHistory) sum += d;
    return sum / this._driftHistory.length;
  }

  destroy() {
    this._destroyed = true;
    this._stopLoops();
    // A page that walks through ten titles would otherwise leave ten live
    // audio contexts behind, and browsers cap how many one page may hold.
    this.timeline.dispose();
    for (const type of ['canplay', 'canplaythrough', 'loadeddata', 'playing']) {
      this.video.removeEventListener(type, this._onVideoReadyish);
      this.audio.removeEventListener(type, this._onAudioReadyish);
    }
    this.video.removeEventListener('waiting', this._onVideoReadyish);
    this.video.removeEventListener('stalled', this._onVideoReadyish);
    this.audio.removeEventListener('waiting', this._onAudioReadyish);
    this.audio.removeEventListener('stalled', this._onAudioReadyish);
    this.audio.removeEventListener('seeking', this._onSeeking);
    this.audio.removeEventListener('seeked', this._onSeeked);
    this.video.removeEventListener('seeked', this._onVideoSeeked);
    this.audio.removeEventListener('ended', this._onEnded);
    this.video.removeEventListener('ended', this._onEnded);
  }
}

export default SyncedMediaController;
