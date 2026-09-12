import { useCallback, useEffect, useRef, useState } from 'react';
import { loadProgress, resumable, saveProgress } from '../lib/progress';
import 'media-chrome';
import '../media/frenflix-video-element';

const STEP_MS = 50;    // VLC nudges audio and subtitle delay in 50ms steps
const SEEK_STEP_S = 10; // matches media-chrome's default seek offset

/**
 * Thin by design: it resolves URLs, hands them to <frenflix-video>, and lets
 * media-chrome drive playback through the standard media API. Swapping this
 * whole component for a different skin touches nothing below it.
 */
export default function Player({ entry, onError, onEnded }) {
  const mediaRef = useRef(null);
  const controllerRef = useRef(null);
  const [audioDelayMs, setAudioDelayMs] = useState(0);
  const [subDelayMs, setSubDelayMs] = useState(0);
  const [subIndex, setSubIndex] = useState(-1);
  const [audioIndex, setAudioIndex] = useState(0);
  const [swapping, setSwapping] = useState(false);
  const [resumedFrom, setResumedFrom] = useState(null);
  const [showDiag, setShowDiag] = useState(false);
  const [sync, setSync] = useState(null);

  const subtitles = entry?.subtitles ?? [];
  const audioTracks = entry?.audioTracks ?? [];

  // Resolve sources whenever the entry changes.
  useEffect(() => {
    let cancelled = false;
    const el = mediaRef.current;
    if (!el || !entry) return undefined;

    setAudioDelayMs(0);
    setSubDelayMs(0);
    setSubIndex(subtitles.length > 0 ? 0 : -1);
    setAudioIndex(0);
    setResumedFrom(null);

    (async () => {
      try {
        const videoUrl = await entry.video.resolveUrl();
        const audioUrl = entry.audio ? await entry.audio.resolveUrl() : null;
        if (cancelled) return;
        el.sources = { videoUrl, audioUrl };

        // Pick up where this file was left off. Keyed on the file, not on the
        // library entry, so a file re-added in a later session still resumes.
        const saved = await loadProgress(entry.video.key);
        if (cancelled || !resumable(saved)) return;
        const seekWhenReady = () => {
          el.currentTime = saved.position;
          setResumedFrom(saved.position);
        };
        if (el.duration > 0) seekWhenReady();
        else el.addEventListener('loadedmetadata', seekWhenReady, { once: true });
      } catch (err) {
        if (!cancelled) onError?.(err);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, onError]);

  // Load and apply the selected subtitle track.
  useEffect(() => {
    let cancelled = false;
    const el = mediaRef.current;
    if (!el) return undefined;
    const track = subIndex >= 0 ? subtitles[subIndex] : null;
    if (!track) { el.subtitleCues = []; return undefined; }
    (async () => {
      try {
        const cues = await track.loadCues();
        if (!cancelled) el.subtitleCues = cues;
      } catch {
        if (!cancelled) el.subtitleCues = [];
      }
    })();
    return () => { cancelled = true; };
  }, [subIndex, subtitles]);

  useEffect(() => { if (mediaRef.current) mediaRef.current.audioDelay = audioDelayMs / 1000; }, [audioDelayMs]);
  useEffect(() => { if (mediaRef.current) mediaRef.current.subtitleOffset = subDelayMs / 1000; }, [subDelayMs]);

  /**
   * Poll the sync status for the panel. Always, not only when the detailed
   * readout is open: the state chip is the thing that tells you at a glance
   * whether the picture and the sound actually agree, so it has to be live.
   */
  useEffect(() => {
    if (!entry?.audio) { setSync(null); return undefined; }
    const id = setInterval(() => {
      if (mediaRef.current) setSync(mediaRef.current.syncStatus);
    }, 250);
    return () => clearInterval(id);
  }, [entry]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return undefined;
    const handler = () => onError?.(el.error || new Error('This file could not be decoded by the browser.'));
    el.addEventListener('error', handler);
    return () => el.removeEventListener('error', handler);
  }, [onError]);

  /**
   * Record the position periodically, and on the way out.
   *
   * `pagehide` rather than `unload`: `unload` is unreliable and blocks the
   * back/forward cache. The interval is what actually catches a closed laptop
   * lid or a killed tab, which is how viewing usually ends.
   */
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !entry) return undefined;
    const key = entry.video.key;
    const title = entry.title;

    const write = () => {
      if (!el || el.paused) return;
      saveProgress(key, { position: el.currentTime, duration: el.duration, title });
    };
    const id = setInterval(write, 5000);
    const onHide = () => saveProgress(key, { position: el.currentTime, duration: el.duration, title });
    const onPause = () => onHide();
    const onEnd = () => {
      // Finished: clear the resume point by storing the end, so `resumable`
      // reports false and it starts from the top next time.
      saveProgress(key, { position: el.duration || 0, duration: el.duration, title });
      onEnded?.();
    };

    window.addEventListener('pagehide', onHide);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnd);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', onHide);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnd);
      onHide();
    };
  }, [entry, onEnded]);

  /**
   * Switch dub track. The video keeps playing throughout — the facade swaps
   * only the audio element and pulls it back onto the picture's clock.
   */
  const chooseAudio = useCallback(async (index) => {
    const el = mediaRef.current;
    if (!el) return;
    setSwapping(true);
    setAudioIndex(index);
    try {
      const track = index >= 0 ? audioTracks[index] : null;
      await el.setAudioTrack(track ? await track.asset.resolveUrl() : null);
    } catch (err) {
      onError?.(err);
    } finally {
      setSwapping(false);
    }
  }, [audioTracks, onError]);

  /**
   * Keyboard.
   *
   * media-chrome has its own hotkeys on <media-controller>, active whenever
   * focus is anywhere inside the player — which it always is right after you
   * click play. Two things fell out of that:
   *
   *   - space was handled twice, by media-chrome and by this listener, so it
   *     paused and immediately unpaused;
   *   - media-chrome's built-in j and k are seek-back and play/pause
   *     (YouTube's bindings), which collided head-on with VLC's j/k for audio
   *     delay: k nudged the delay *and* paused, j nudged it *and* jumped back
   *     ten seconds.
   *
   * So the two are separated explicitly. j/k/g/h are disabled on the
   * controller (`hotkeys="noj nok"` plus g/h it never claimed) and owned here.
   * The standard transport keys stay media-chrome's whenever the event came
   * from inside the player; this listener only covers them when focus is
   * elsewhere on the page, where media-chrome would never see them. Seek is
   * 10s either way, matching media-chrome's default, so the step doesn't
   * change depending on what happens to have focus.
   */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = mediaRef.current;
      if (!el) return;

      const controller = controllerRef.current;
      const fromPlayer = controller && (e.target === controller || controller.contains(e.target));

      switch (e.key) {
        // Ours alone — disabled on the controller, so they never double up.
        case 'j': setAudioDelayMs((v) => v - STEP_MS); break;
        case 'k': setAudioDelayMs((v) => v + STEP_MS); break;
        case 'g': setSubDelayMs((v) => v - STEP_MS); break;
        case 'h': setSubDelayMs((v) => v + STEP_MS); break;

        // media-chrome's when the player has focus; ours when it doesn't.
        case ' ':
          if (fromPlayer) return;
          e.preventDefault();
          if (el.paused) el.play(); else el.pause();
          break;
        case 'ArrowLeft':
          if (fromPlayer) return;
          e.preventDefault();
          el.currentTime = Math.max(0, el.currentTime - SEEK_STEP_S);
          break;
        case 'ArrowRight':
          if (fromPlayer) return;
          e.preventDefault();
          el.currentTime = el.currentTime + SEEK_STEP_S;
          break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // media-chrome marks itself `userinactive` when the control bar hides. Mirror
  // that onto the media element so subtitles can lift clear of the controls.
  useEffect(() => {
    const controller = controllerRef.current;
    const el = mediaRef.current;
    if (!controller || !el) return undefined;
    const sync = () => {
      if (controller.hasAttribute('userinactive')) el.removeAttribute('controls-visible');
      else el.setAttribute('controls-visible', '');
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(controller, { attributes: true, attributeFilter: ['userinactive'] });
    return () => observer.disconnect();
  }, []);

  const nudge = useCallback((setter, delta) => setter((v) => v + delta), []);

  return (
    <div className="w-full">
      {/* hotkeys="noj nok": media-chrome binds j and k to seek-back and
          play/pause. Those are VLC's audio-delay keys here, so its versions
          are switched off rather than left to fire alongside ours. */}
      <media-controller
        ref={controllerRef}
        hotkeys="noj nok"
        class="w-full aspect-video bg-black rounded-xl overflow-hidden"
      >
        <frenflix-video ref={mediaRef} slot="media" />
        <media-loading-indicator slot="centered-chrome" />
        <media-control-bar>
          <media-play-button />
          <media-seek-backward-button seekoffset="10" />
          <media-seek-forward-button seekoffset="10" />
          <media-time-range />
          <media-time-display showduration="" />
          <media-mute-button />
          <media-volume-range />
          <media-playback-rate-button />
          <media-pip-button />
          <media-fullscreen-button />
        </media-control-bar>
      </media-controller>

      {resumedFrom !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-2 text-sm">
          <span className="text-neutral-300">
            Resumed from {Math.floor(resumedFrom / 60)}:{String(Math.floor(resumedFrom % 60)).padStart(2, '0')}
          </span>
          <button
            type="button"
            onClick={() => {
              if (mediaRef.current) mediaRef.current.currentTime = 0;
              setResumedFrom(null);
            }}
            className="text-neutral-400 underline hover:text-white"
          >
            start from the beginning
          </button>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Audio sync */}
        <section className="rounded-xl border border-edge bg-panel px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-white">Audio sync</h3>
            {sync && <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATE_STYLE[sync.state] || ''}`}>
              {STATE_LABEL[sync.state] || sync.state} ±{Math.round(sync.p95Ms)} ms
            </span>}
            <kbd className="text-[11px] text-neutral-600">j / k</kbd>
          </div>

          {entry?.audio ? (
            <>
              <div className="mt-3 flex gap-1" role="group" aria-label="Sync mode">
                {['auto', 'manual', 'off'].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { if (mediaRef.current) { mediaRef.current.syncMode = m; setSync(mediaRef.current.syncStatus); } }}
                    className={`flex-1 rounded-lg border px-2 py-1 text-xs capitalize transition-colors ${
                      sync?.mode === m
                        ? 'border-accent bg-accent/15 text-white'
                        : 'border-edge text-neutral-400 hover:border-neutral-500 hover:text-white'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button type="button" onClick={() => nudge(setAudioDelayMs, -STEP_MS)} className={stepBtn}>−50ms</button>
                <span className="w-24 text-center tabular-nums text-sm text-neutral-200">
                  {audioDelayMs > 0 ? '+' : ''}{audioDelayMs} ms
                </span>
                <button type="button" onClick={() => nudge(setAudioDelayMs, STEP_MS)} className={stepBtn}>+50ms</button>
                {audioDelayMs !== 0 && (
                  <button type="button" onClick={() => setAudioDelayMs(0)} className="ml-1 text-xs text-neutral-400 underline hover:text-white">
                    reset
                  </button>
                )}
              </div>

              <input
                type="range" min="-1000" max="1000" step="10"
                value={audioDelayMs}
                onChange={(e) => setAudioDelayMs(Number(e.target.value))}
                className="mt-3 w-full accent-accent"
                aria-label="Audio delay in milliseconds"
              />

              {sync && (
                <p className="mt-2 text-xs text-neutral-500">
                  {sync.mode === 'auto' ? (
                    <>
                      Holding the picture back {Math.abs(Math.round(sync.autoOffsetMs))} ms to meet the sound,
                      {sync.clock === 'measured' ? ' measured' : ' estimated'} from the audio output.
                    </>
                  ) : sync.mode === 'manual' ? (
                    'Ignoring the measured output path — the delay above is the only correction.'
                  ) : (
                    'No correction at all. Useful for hearing what the compensation is doing.'
                  )}
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">Using the video&rsquo;s own audio track.</p>
          )}
        </section>

        {/* Audio track */}
        <section className="rounded-xl border border-edge bg-panel px-4 py-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-white">Audio track</h3>
            {swapping && <span className="text-[11px] text-neutral-500">switching…</span>}
          </div>
          {audioTracks.length > 0 ? (
            <>
              <select
                value={audioIndex}
                onChange={(e) => chooseAudio(Number(e.target.value))}
                disabled={swapping}
                className="mt-2 w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-neutral-200 disabled:opacity-50"
                aria-label="Audio track"
              >
                {audioTracks.map((t, i) => (
                  <option key={t.audioId} value={i}>{t.asset.name}</option>
                ))}
                <option value={-1}>The video&rsquo;s own track</option>
              </select>
              <p className="mt-2 text-xs text-neutral-500">
                {audioTracks.length === 1
                  ? 'One external track paired by name.'
                  : `${audioTracks.length} tracks paired by name. Switching keeps the picture running.`}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">
              No separate audio — playing the video&rsquo;s own track.
            </p>
          )}
        </section>

        {/* Subtitles */}
        <section className="rounded-xl border border-edge bg-panel px-4 py-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-white">Subtitles</h3>
            <kbd className="text-[11px] text-neutral-600">g / h</kbd>
          </div>
          {subtitles.length > 0 ? (
            <>
              <select
                value={subIndex}
                onChange={(e) => setSubIndex(Number(e.target.value))}
                className="mt-2 w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-neutral-200"
                aria-label="Subtitle track"
              >
                <option value={-1}>Off</option>
                {subtitles.map((s, i) => (
                  <option key={s.id} value={i}>{s.name}</option>
                ))}
              </select>
              {subIndex >= 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <button type="button" onClick={() => nudge(setSubDelayMs, -STEP_MS)} className={stepBtn}>−50ms</button>
                  <span className="w-24 text-center tabular-nums text-sm text-neutral-200">
                    {subDelayMs > 0 ? '+' : ''}{subDelayMs} ms
                  </span>
                  <button type="button" onClick={() => nudge(setSubDelayMs, STEP_MS)} className={stepBtn}>+50ms</button>
                  {subDelayMs !== 0 && (
                    <button type="button" onClick={() => setSubDelayMs(0)} className="ml-1 text-xs text-neutral-400 underline hover:text-white">
                      reset
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">
              No subtitle file for this title. Drop a .srt or .vtt anywhere on this page.
            </p>
          )}
        </section>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-neutral-500">
        <button type="button" onClick={() => setShowDiag((s2) => !s2)} className="underline hover:text-white">
          {showDiag ? 'hide sync readout' : 'sync readout'}
        </button>
        {showDiag && sync && (
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
            <span>
              now <b className={Math.abs(sync.errorMs) > 45 ? 'text-accent' : 'text-emerald-400'}>
                {sync.errorMs.toFixed(0)} ms
              </b>
            </span>
            <span>p95 {sync.p95Ms.toFixed(0)} ms</span>
            <span>peak {sync.peakMs.toFixed(0)} ms</span>
            <span>output path {sync.latencyMs.toFixed(0)} ms ({sync.clock})</span>
            <span>offset {sync.totalOffsetMs.toFixed(0)} ms = yours {sync.userOffsetMs.toFixed(0)} + auto {sync.autoOffsetMs.toFixed(0)}</span>
            <span>trim {sync.trimPercent.toFixed(2)}%</span>
            {sync.clockNote && <span className="text-amber-400">{sync.clockNote}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

const STATE_LABEL = { locked: 'Locked', tracking: 'Tracking', correcting: 'Correcting', off: 'Off' };
const STATE_STYLE = {
  locked: 'bg-emerald-500/15 text-emerald-300',
  tracking: 'bg-sky-500/15 text-sky-300',
  correcting: 'bg-amber-500/15 text-amber-300',
  off: 'bg-neutral-500/15 text-neutral-400',
};

const stepBtn = 'rounded-lg border border-edge px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white';
