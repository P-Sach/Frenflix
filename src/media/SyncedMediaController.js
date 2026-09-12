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
/**
 * Longest the first frame is held back, seconds.
 *
 * There is no earlier frame than the first, so at the top of a file the
 * picture cannot be held back by moving it — it is held back by *waiting*.
 * The cap is a little under the ceiling on a believable output path: a third
 * of a second of the opening frame sitting still is not noticeable, and
 * anything longer would mean the latency reading is wrong rather than large.
 */
const MAX_START_HOLD = 0.4;
/** Smoothing on the reported error. Diagnostics only; the loop uses the raw value. */
const ERROR_SMOOTHING = 0.2;
const READY_ENOUGH = 3;      // HAVE_FUTURE_DATA

/**
 * Buffer thresholds, and why `readyState` alone will not do.
 *
 * `HAVE_FUTURE_DATA` means roughly one frame of lookahead. Using it as the
 * gate for "may we play?" is self-defeating on any source that cannot be fed
 * faster than it is consumed: it resolves true, playback drains the frame it
 * was waiting for, it resolves false, both elements are paused, a `canplay`
 * fires and it resolves true again — several times a second. Each cycle stops
 * and restarts the audio, and what comes out is the broken-record sound.
 * Measured on a 3.4 Mbit/s video down a 2.5 Mbit/s pipe: 24 play and 22 pause
 * events in twenty seconds, with the audio advancing at 0.056x.
 *
 * The cure is hysteresis, which is how every real player behaves: wait for a
 * genuine buffer before starting, tolerate a brief shortage without calling it
 * starvation, and once held, stay held until there is enough to play through.
 * One clean hold instead of a stutter.
 */
const START_BUFFER = 0.35;      // buffered ahead on BOTH sides before playback begins
const RESUME_BUFFER = 1.5;      // ...and before it resumes after a rebuffer
const START_TIMEOUT_MS = 4000;  // a source that never reports a healthy buffer still plays
const STALL_GRACE_MS = 300;     // a seek settling: wait this long before calling it starvation
const HICCUP_GRACE_MS = 120;    // no seek in flight: a single late frame, and no longer
const MIN_HOLD_MS = 250;        // once held, hold long enough to be worth holding
/**
 * How long the sound may run with the picture standing still before the start
 * is abandoned and retried.
 *
 * Every readiness check in here asks the element whether it *could* play. None
 * of them prove it *did*. On a large file whose decoder takes its time — a
 * 108 MB 1080p H.264 on Windows, reported as two seconds of audio over a
 * frozen first frame — the gate passes, both are asked to play, the sound
 * runs, and the picture does not. By the time the correction loop notices, the
 * gap is seconds wide and closing it means seeking a decoder that is already
 * struggling.
 *
 * So the start is supervised by the only evidence that settles it: whether the
 * picture's position actually moved. Nothing here makes a healthy start any
 * slower — a healthy picture advances within a frame or two.
 */
const START_WATCHDOG_MS = 200;
/**
 * How many times a start is abandoned before the loop is left to cope.
 *
 * One is enough, because the retry is not a repeat: the first failure switches
 * to bringing the picture up alone and letting the sound join it once the
 * picture has demonstrably moved (see `_warmUp`). Retrying the same
 * simultaneous start would just leak the same gap again.
 */
const MAX_START_ABORTS = 1;

export class SyncedMediaController extends EventTarget {
  constructor(videoEl, audioEl) {
    super();
    this.video = videoEl;
    this.audio = audioEl;

    this.hasExternalAudio = false;
    /**
     * Set when the external track has run out while the picture has not. The
     * pair carries on without it — see `_onAudioEnded`.
     */
    this.audioExhausted = false;
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
    /** performance.now() until which the picture is deliberately held still. */
    this._videoHoldUntil = 0;
    /** Buffer gate bookkeeping, all Date.now() or 0 for "not currently". */
    this._startRequestedAt = 0;
    this._shortageSince = 0;
    this._stalledAt = 0;
    /** Whether the controls layer has been told the wait is buffering. */
    this._primingNotified = false;
    /** Start watchdog: when the sound began running without the picture. */
    this._watchdogAt = 0;
    this._abortedStarts = 0;
    /** Bringing the picture up alone after a start that never moved. */
    this._warmingUp = false;
    this._warmingSince = 0;
    /** Where the picture was when it was last asked to play. */
    this._videoStartedFrom = 0;
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
    this._onVideoEnded = () => this._finish();
    /*
     * A dub is very often a second or two shorter than the film it belongs to.
     * That is not the end of the film.
     *
     * Ending the pair on whichever stream runs out first made a 6:13 video
     * stop at 6:11 with the last two seconds of picture never shown — and,
     * because the audio is the master clock, the time display froze there too.
     * So the audio running out is a demotion, not an ending: the picture plays
     * on to its own end in silence, and the clock falls back to the picture
     * for the remainder (see `master`).
     */
    this._onAudioEnded = () => {
      const left = (this.video.duration || 0) - this.video.currentTime;
      if (!this.video.ended && Number.isFinite(left) && left > 0.25) {
        this.audioExhausted = true;
        if (this._phase !== 'off') this._phase = 'audio-ended';
        this.videoClock.reset();
        this.dispatchEvent(new Event('audioended'));
        return;
      }
      this._finish();
    };

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
    this.audio.addEventListener('ended', this._onAudioEnded);
    this.video.addEventListener('ended', this._onVideoEnded);

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
    this._videoHoldUntil = 0;
    this._startRequestedAt = 0;
    this._shortageSince = 0;
    this._stalledAt = 0;
    this._primingNotified = false;
    this._watchdogAt = 0;
    this._abortedStarts = 0;
    this._warmingUp = false;
    this._warmingSince = 0;
    this.audioExhausted = false;
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

  /** The element carrying sound. Stays the audio even once it has run out, so
   *  volume and mute keep addressing the same thing. */
  get soundElement() {
    return this.hasExternalAudio ? this.audio : this.video;
  }

  /**
   * External audio that is still taking part: there is a track, and it has not
   * run out before the picture. Everything about syncing — readiness, the
   * correction loop, starting and holding — is conditioned on this rather than
   * on `hasExternalAudio`, because a track that has ended is not something to
   * wait for, start, or measure against.
   */
  get audioActive() {
    return this.hasExternalAudio && !this.audioExhausted;
  }

  /** The master clock: the sound while there is sound, the picture after. */
  get master() {
    return this.audioActive ? this.audio : this.video;
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
    // The start gate is timed from here, so a source that never reports a
    // healthy buffer still plays rather than waiting for ever.
    this._startRequestedAt = Date.now();
    this._shortageSince = 0;
    this._stalledAt = 0;
    this._primingNotified = false;
    this._watchdogAt = 0;
    this._abortedStarts = 0;
    this._warmingUp = false;
    this._warmingSince = 0;
    this._startLoops();
    return this._reconcile();
  }

  /** A real end: the picture is done. */
  _finish() {
    this.wantPlay = false;
    this._pauseBoth();
    this.dispatchEvent(new Event('ended'));
  }

  pause() {
    this.wantPlay = false;
    this.stalled = false;
    this._hasStarted = false;
    this._settleArmed = false;
    this._startRequestedAt = 0;
    this._shortageSince = 0;
    this._stalledAt = 0;
    this._primingNotified = false;
    this._warmingUp = false;
    this._warmingSince = 0;
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
    // A seek drops readyState on both sides for a moment. That is not
    // starvation, and the shortage timer must not carry the old reading into
    // it. The start gate's clock restarts too, but note `_reconcile` only ever
    // *withholds* a start — it never pauses elements that are already running,
    // so a seek mid-playback is not interrupted by the refill.
    this._startRequestedAt = Date.now();
    this._shortageSince = 0;
    this._watchdogAt = 0;
    this._abortedStarts = 0;
    this._warmingUp = false;
    this._warmingSince = 0;
    // Seeking back into the film brings a track that had run out back into it.
    if (this.hasExternalAudio && t < (this.audio.duration || Infinity) - 0.25) {
      this.audioExhausted = false;
    }
    if (this.audioActive) {
      this.audio.currentTime = t;
      // Clamped deliberately: near zero the picture cannot be held back by
      // position, so `_playBoth` holds it back by time instead.
      this.video.currentTime = Math.max(0, t + this.effectiveOffset);
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

  /** Seconds of contiguous data ahead of where this element is sitting. */
  _bufferedAhead(el) {
    const t = el.currentTime;
    const ranges = el.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      // A tolerance on the near edge: the range often starts a few
      // milliseconds after the position the element reports.
      if (ranges.start(i) <= t + 0.05 && ranges.end(i) > t) return ranges.end(i) - t;
    }
    return 0;
  }

  /**
   * Is there enough of this element buffered to be worth starting?
   *
   * @param {HTMLMediaElement} el
   * @param {number} need seconds wanted ahead of the current position
   */
  _healthy(el, need) {
    // HAVE_ENOUGH_DATA is the browser saying it believes it can play through
    // to the end. There is nothing to add to that.
    if (el.readyState >= 4) return true;
    if (el.readyState < READY_ENOUGH) return false;
    const ahead = this._bufferedAhead(el);
    if (ahead >= need) return true;
    // Near the end of the file there may be less than `need` left to buffer,
    // ever — waiting for it would hang the last seconds of every title.
    const left = (el.duration || 0) - el.currentTime;
    return Number.isFinite(left) && left > 0 && ahead >= left - 0.05;
  }

  /** Both sides, or just the video when it is carrying its own sound. */
  _bothHealthy(need) {
    if (!this._healthy(this.video, need)) return false;
    return !this.audioActive || this._healthy(this.audio, need);
  }

  _reconcile() {
    if (this._destroyed) return undefined;

    if (!this.wantPlay) {
      this._phase = 'idle';
      this._pauseBoth();
      return undefined;
    }

    // Asked to play before there is anything to play: a Drive title is still
    // being copied to this device. The intent is kept — it is honoured the
    // moment the source lands — and nothing is started meanwhile, because
    // calling play() on a source-less element ten times a second achieves
    // nothing but noise in the console.
    if (!this.video.src && !this.video.currentSrc) {
      this._phase = 'no-source';
      return undefined;
    }

    if (this.syncMode === 'off') this._phase = 'off';
    else if (this.video.seeking || this.audio.seeking) this._phase = 'seeking';

    // A lone <video> manages its own buffering and has nothing to sync with.
    // The same is true once an external track has run out before the picture:
    // there is nothing left to hold the picture to.
    if (!this.audioActive) {
      this._playBoth();
      return undefined;
    }

    const videoReady = this._ready(this.video);
    const audioReady = this._ready(this.audio);

    const now = Date.now();

    /*
     * Before playback has begun: wait for a real buffer, not for a frame.
     *
     * Note what this branch does NOT do — it never pauses. It withholds a
     * start. `preload` is forced to 'auto' in `setSources`, so a paused
     * element does keep filling (the old deadlock was 'metadata', where it
     * does not), and `START_TIMEOUT_MS` is the backstop for a source that
     * never reports a healthy buffer at all. Elements already running — after
     * a seek, which also clears `_hasStarted` — are left running.
     */
    if (!this._hasStarted) {
      if (this._phase !== 'off') this._phase = 'starting';
      // A start already abandoned once is not retried the same way.
      if (this._warmingUp) return this._warmUp(now);
      const timedOut = this._startRequestedAt > 0 && now - this._startRequestedAt > START_TIMEOUT_MS;
      if (!timedOut && !this._bothHealthy(START_BUFFER) && this.video.paused && this.audio.paused) {
        if (this._phase !== 'off') this._phase = 'priming';
        // A prime that drags on needs to look like buffering rather than like
        // a dead player, so the controls layer is told once. Deliberately not
        // via `this.stalled`, which is the post-start hold and carries the
        // much stricter resume threshold with it.
        if (!this._primingNotified && now - this._startRequestedAt > 400) {
          this._primingNotified = true;
          this.dispatchEvent(new Event('stalled'));
        }
        return undefined;
      }
      if (videoReady && audioReady && !this.video.paused && !this.audio.paused) {
        this._hasStarted = true;
        this._shortageSince = 0;
        this._watchdogAt = 0;
        if (this._primingNotified) {
          this._primingNotified = false;
          this.dispatchEvent(new Event('resumed'));
        }
        if (this._phase !== 'off') this._phase = 'running';
        if (this._settleArmed) {
          this._settleArmed = false;
          // The offset was already applied while paused, so this only catches
          // a start that went genuinely wrong. Small gaps are the loop's job,
          // and it closes them in well under a second — whereas seeking a
          // decoder that has only just started is itself a visible stall, and
          // "the video starts late" is exactly what that looks like. Hence a
          // threshold wide enough that only a broken start trips it.
          this._alignVideoNow(0.35);
        }
      } else if (!this.audio.paused && this._videoHoldUntil <= performance.now()) {
        // Asked to play, sound running, picture standing still. See
        // START_WATCHDOG_MS: readiness says the picture *could* play; only its
        // position moving says it *did*.
        // Not `|| this.video.paused`: a picture that was asked to play and is
        // still standing there IS the failure. The hold check above is what
        // keeps the deliberate wait at the top of a file out of this.
        const moved = this.video.currentTime > this._videoStartedFrom + 0.02;
        if (moved) {
          this._watchdogAt = 0;
        } else if (!this._watchdogAt) {
          this._watchdogAt = now;
        } else if (now - this._watchdogAt > START_WATCHDOG_MS
          && this._abortedStarts < MAX_START_ABORTS) {
          this._abandonStart();
          return undefined;
        }
      }
      this._playBoth();
      return undefined;
    }

    /*
     * Already held. Stay held until there is enough to play *through* — this
     * is the other half of the hysteresis, and the half that turns a stutter
     * into one clean buffering pause.
     */
    if (this.stalled) {
      const heldLongEnough = now - this._stalledAt >= MIN_HOLD_MS;
      if (heldLongEnough && this._bothHealthy(RESUME_BUFFER)) {
        this.stalled = false;
        this._shortageSince = 0;
        this._realignOnResume();
        if (this._phase !== 'off') this._phase = 'running';
        this.dispatchEvent(new Event('resumed'));
        this._playBoth();
      } else {
        if (this._phase !== 'off') this._phase = 'stalled';
        this._pauseBoth();
      }
      return undefined;
    }

    if (!videoReady || !audioReady) {
      // A shortage this brief is a seek settling, or a single late frame.
      // Calling it starvation and pausing both is what produced the stutter.
      //
      // But the grace is not free: while it runs, the starved side's picture
      // is frozen and the sound runs on, so every millisecond of grace is a
      // millisecond of gap to close afterwards. A seek genuinely needs 300 ms
      // to settle. A shortage with nothing seeking is starvation from the
      // first sample, and gets only enough room to absorb one late frame.
      const settling = this.video.seeking || this.audio.seeking || this._resyncPending;
      const grace = settling ? STALL_GRACE_MS : HICCUP_GRACE_MS;
      if (!this._shortageSince) this._shortageSince = now;
      if (now - this._shortageSince < grace) {
        if (this._phase !== 'off') this._phase = 'thin';
        this._playBoth();
        return undefined;
      }
      // One side genuinely ran short. Hold them together rather than letting
      // the ready one run on. (VLC does the same: delay the others rather
      // than race the one that fell behind.)
      if (this._phase !== 'off') this._phase = 'stalled';
      if (!this._resyncPending) {
        this.stalled = true;
        this._stalledAt = now;
        this.dispatchEvent(new Event('stalled'));
      }
      this._pauseBoth();
      return undefined;
    }

    this._shortageSince = 0;
    if (this._phase !== 'off' && !this.video.seeking && !this.audio.seeking) this._phase = 'running';
    this._playBoth();
    return undefined;
  }

  /**
   * Give up on a start that never happened, and set up a clean retry.
   *
   * The sound goes back to where the picture actually got to, so the retry
   * starts them together rather than seconds apart — and so nothing is
   * skipped, which a forward video seek would have done. Then the buffer gate
   * is re-armed: it will hold both until the picture is genuinely ready, which
   * is the wait the viewer should have had in the first place. Bounded by
   * MAX_START_ABORTS, because a picture that will never move is better late
   * than a player that restarts for ever.
   */
  _abandonStart() {
    this._abortedStarts += 1;
    this._watchdogAt = 0;
    this._pauseBoth();
    const at = this.video.currentTime;
    if (this.audioActive && Number.isFinite(at)) {
      const want = Math.max(0, at - this.effectiveOffset);
      if (Math.abs(this.audio.currentTime - want) > 0.05) this.audio.currentTime = want;
    }
    this.timeline.reset();
    this.videoClock.reset();
    this._settleArmed = true;
    this._startRequestedAt = Date.now();
    this._warmingUp = true;
    this._warmingSince = Date.now();
    if (this._phase !== 'off') this._phase = 'restarting';
  }

  /**
   * The second attempt: bring the picture up alone, then let the sound join it.
   *
   * The video is muted whenever there is an external track, so running it by
   * itself makes no sound at all — which is what makes this safe. Nothing is
   * heard until the picture's position has actually advanced, and then the
   * sound is placed *at the picture* and started. The worst case is a picture
   * that begins a fraction of a second before its sound, which is the right
   * way round and nothing like two seconds of sound over a frozen frame.
   *
   * The picture is never seeked here. It is the side that is struggling, and
   * flushing its decoder is the last thing it needs.
   */
  _warmUp(now) {
    if (this._phase !== 'off') this._phase = 'warming';
    if (!this.audio.paused) this.audio.pause();
    if (this.video.paused) {
      this._videoStartedFrom = this.video.currentTime;
      this.video.play().catch(() => { /* superseded */ });
      return undefined;
    }
    const moved = this.video.currentTime > this._videoStartedFrom + 0.05;
    const waitedLongEnough = this._warmingSince > 0 && now - this._warmingSince > START_TIMEOUT_MS;
    if (!moved && !waitedLongEnough) return undefined;
    this._warmingUp = false;
    this._warmingSince = 0;
    const want = this.video.currentTime - this.effectiveOffset;
    if (this.audioActive && Number.isFinite(want) && want >= 0
      && Math.abs(this.audio.currentTime - want) > 0.05) {
      this.audio.currentTime = want;
    }
    this.timeline.reset();
    if (this.audioActive) this.audio.play().catch(() => { /* superseded */ });
    return undefined;
  }

  /**
   * Close the gap a buffering hold left behind — by moving the sound, not the
   * picture.
   *
   * While the shortage was being ridden out, the starved side's picture was
   * frozen and the sound ran on. Something has to give, and the instinct is to
   * seek the video forward to where the audio got to. That is the wrong way
   * round on a pipe that is already too thin: a forward seek flushes the video
   * decoder, throws away the buffer the hold just spent 1.5 s accumulating,
   * and walks straight back into the stall. Traced on a 3.4 Mbit/s file down a
   * 2.5 Mbit/s pipe, that is what turned one hold into a run of them, ending
   * 290 ms out of sync.
   *
   * So the audio goes back to the picture instead. It is the cheap side to
   * move — a fully buffered local track seeks instantly — and a replayed
   * fraction of a second of sound is a far smaller artefact than a stutter.
   * Called while both are still paused, so nothing is heard mid-flight.
   */
  _realignOnResume() {
    if (!this.audioActive) return;
    const want = this.video.currentTime - this.effectiveOffset;
    if (!Number.isFinite(want) || want < 0) return;
    if (Math.abs(this.audio.currentTime - want) <= 0.05) return;
    this.audio.currentTime = want;
    this.timeline.reset();
  }

  async _playBoth() {
    const now = performance.now();
    // A hold in progress is not a video that failed to start.
    const holding = this._videoHoldUntil > now;
    // Never `audioActive === false`: play() on an element that has ended
    // restarts it from zero, which would drop the film back to its opening.
    const startAudio = this.audioActive && this.audio.paused;
    const startVideo = this.video.paused && !holding;
    if (!startAudio && !startVideo) return;

    // Pre-position the video BEFORE either element starts.
    //
    // The video has to sit `effectiveOffset` ahead of the audio, and that
    // offset used to be applied by seeking just after playback began. Seeking a
    // running decoder flushes and refills it — a stall that hits the video
    // only, which is seen as "the video starts late". While both are still
    // paused the same seek is free, and nobody is watching yet.
    let holdMs = 0;
    if (this.audioActive && startAudio && startVideo) {
      // Only worth a seek if the offset is big enough to matter — a typical
      // wired output is ~10ms, which the rate controller absorbs in a third of
      // a second with nothing to see. Bluetooth's 150-300ms is worth the seek,
      // and it is free here because playback has not started.
      const target = this.audio.currentTime + this.effectiveOffset;
      if (!Number.isFinite(target)) {
        // nothing sensible to aim at; start together and let the loop work
      } else if (target >= 0) {
        if (Math.abs(this.video.currentTime - target) > 0.03) this.video.currentTime = target;
      } else {
        /*
         * The target is before the start of the file, which is the ordinary
         * case at the top of a film: the sound leaves the hardware some
         * milliseconds after it is rendered, so the frame that belongs with
         * the first sound is a frame that does not exist.
         *
         * Seeking cannot express that, and this is why the opening second
         * looked out of sync however good the measurement was — the offset
         * was silently clamped to zero and the rate loop then had to claw it
         * back while the viewer watched. What *can* express it is time: hold
         * the first frame still and let the audio run on ahead by exactly the
         * deficit. The picture starts a few tens of milliseconds late, which
         * nobody can see, and it starts already in sync.
         */
        if (this.video.currentTime > 0.03) this.video.currentTime = 0;
        holdMs = (Math.min(-target, MAX_START_HOLD) * 1000) / this._rate;
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
    if (startVideo && holdMs > 4) {
      this._videoHoldUntil = now + holdMs;
      this._videoStartedFrom = this.video.currentTime;
      // Reconcile again when the hold expires rather than waiting for the
      // next tick: a 100ms tick would turn a 60ms hold into a 160ms one.
      setTimeout(() => { if (!this._destroyed) this._reconcile(); }, holdMs + 4);
    } else if (startVideo) {
      this.videoClock.reset();
      // Recorded so the watchdog can tell "asked to play" from "playing".
      this._videoStartedFrom = this.video.currentTime;
      pending.push(this.video.play().catch(() => { /* superseded */ }));
    }
    await Promise.all(pending);
  }

  _pauseBoth() {
    this._videoHoldUntil = 0;
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
    if (!this.audioActive) return;
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
    return this.audioActive
      && this._hasStarted
      && !this.stalled
      // Starved, not merely held: correcting a video that has no data to
      // present makes the picture jump forward a second at a time while the
      // sound runs on regardless. There is nothing to correct until it can
      // play again.
      && this._ready(this.video)
      && this._ready(this.audio)
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
      /** True when the output path is last visit's measurement, not this one's. */
      clockSeeded: Boolean(this.timeline.seeded),
      /** The external track ran out before the picture; playing on in silence. */
      audioExhausted: Boolean(this.audioExhausted),
      /** Starts abandoned because the picture never moved. Should be 0. */
      startAborts: this._abortedStarts || 0,
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
    this.audio.removeEventListener('ended', this._onAudioEnded);
    this.video.removeEventListener('ended', this._onVideoEnded);
  }
}

export default SyncedMediaController;
