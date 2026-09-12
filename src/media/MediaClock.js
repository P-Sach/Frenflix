/**
 * A smoothed read of a media element's playback position.
 *
 * `HTMLMediaElement.currentTime` is not a continuous clock. It is the
 * "official playback position", updated at intervals the browser chooses, so
 * reading it gives a *lagging step function*: correct at the moment it was
 * set, then stale until the next update. Comparing two elements by reading
 * `currentTime` on both measures mostly quantisation noise — tens of
 * milliseconds of it — and then "corrects" for that noise.
 *
 * The fix is to model the clock rather than sample it. The true position only
 * ever runs at or ahead of what `currentTime` reports, so the best estimate is
 * the *upper envelope* of recent samples projected forward at the playback
 * rate. A +/-30 ms staircase becomes a line good to a few ms.
 *
 * The envelope is only trustworthy while playback is continuous, which is why
 * every discontinuity (seek, pause, stall, rate change, source change) has to
 * call `reset()`, and why a projection is refused once it would have to run
 * further than `maxProjectionMs` past the newest sample: a stale sample
 * projected forward across a stall reports a position the element never
 * reached, and injects error at exactly the moment sync matters most.
 */
export class MediaClock {
  /**
   * @param {HTMLMediaElement} el
   * @param {{windowMs?: number, maxProjectionMs?: number}} [opts]
   */
  constructor(el, { windowMs = 500, maxProjectionMs = 400 } = {}) {
    this.el = el;
    this.windowMs = windowMs;
    this.maxProjectionMs = maxProjectionMs;
    this.samples = [];
    this.rate = 1;
  }

  /** Drop history. Call on seek, pause, source change — anything discontinuous. */
  reset() {
    this.samples.length = 0;
  }

  /** Record one observation. Cheap; call it often. */
  sample(now = performance.now()) {
    const t = this.el.currentTime;
    if (!Number.isFinite(t)) return;
    this.rate = this.el.playbackRate || 1;
    this.samples.push({ now, t });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].now < cutoff) this.samples.shift();
  }

  /**
   * Estimated media position at a given moment on the performance.now() clock.
   * `at` may be in the future — rVFC hands us the time a frame is *expected to
   * be displayed*, and that is the instant we actually want to align to.
   *
   * @returns {number} seconds, falling back to a raw read when the model has
   *   nothing recent enough to project from.
   */
  estimate(at = performance.now()) {
    const n = this.samples.length;
    if (n === 0) return this.el.currentTime;
    if (at - this.samples[n - 1].now > this.maxProjectionMs) return this.el.currentTime;
    let best = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const s = this.samples[i];
      const projected = s.t + (this.rate * (at - s.now)) / 1000;
      if (projected > best) best = projected;
    }
    return best;
  }

  get hasHistory() {
    return this.samples.length > 1;
  }
}

export default MediaClock;
