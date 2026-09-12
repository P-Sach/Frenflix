import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../lib/sources';

/**
 * The wait a Drive title has that a dropped file does not.
 *
 * Drive will not serve ranged reads to a browser, so the file has to be copied
 * to local storage before it can be played (see `lib/drive/api.js`). On a big
 * film that is minutes, and a player that sits there for four minutes looks
 * broken. So it is shown: what is being fetched, how far along, how fast, and
 * how long is left.
 *
 * It only appears the first time. The copy outlives the tab, so a second
 * viewing starts as fast as a local file.
 */

const IDLE = { status: 'ready', progress: 1, loaded: 0, total: 0, error: null };

function useAssetState(asset) {
  const [state, setState] = useState(() => (asset?.origin === 'drive' ? asset.cacheState : IDLE));
  useEffect(() => {
    if (!asset || asset.origin !== 'drive') { setState(IDLE); return undefined; }
    return asset.subscribe(setState);
  }, [asset]);
  return state;
}

/**
 * Bytes per second, smoothed.
 *
 * A raw sample-to-sample rate on a download swings wildly enough to be useless
 * as an estimate, so it is run through an exponential average — slow enough to
 * be steady, fast enough to notice when the connection changes.
 */
function useRate(loaded, active) {
  const [rate, setRate] = useState(0);
  const last = useRef({ at: 0, loaded: 0, smooth: 0 });

  useEffect(() => {
    if (!active) { last.current = { at: 0, loaded: 0, smooth: 0 }; setRate(0); return; }
    const now = performance.now();
    const prev = last.current;
    if (!prev.at) { last.current = { at: now, loaded, smooth: 0 }; return; }
    const dt = (now - prev.at) / 1000;
    if (dt < 0.5) return;                       // too short a gap to mean anything
    const instant = Math.max(0, (loaded - prev.loaded) / dt);
    const smooth = prev.smooth ? prev.smooth + (instant - prev.smooth) * 0.25 : instant;
    last.current = { at: now, loaded, smooth };
    setRate(smooth);
  }, [loaded, active]);

  return rate;
}

function eta(remaining, rate) {
  if (!rate || !remaining) return '';
  const secs = remaining / rate;
  if (secs < 60) return `${Math.ceil(secs)}s left`;
  if (secs < 3600) return `${Math.ceil(secs / 60)} min left`;
  return `${(secs / 3600).toFixed(1)} h left`;
}

function Row({ asset, state }) {
  const active = state.status === 'downloading';
  const rate = useRate(state.loaded, active);
  if (!asset || asset.origin !== 'drive' || state.status === 'ready') return null;

  const total = state.total || asset.size || 0;
  const pct = Math.round((state.progress || 0) * 100);
  const left = eta(Math.max(0, total - state.loaded), rate);

  return (
    <div className="mt-3 first:mt-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm text-neutral-300" title={asset.name}>{asset.name}</span>
        <span className="shrink-0 tabular-nums text-xs text-neutral-500">
          {active
            ? `${formatBytes(state.loaded)} of ${formatBytes(total)} · ${pct}%`
            : state.status === 'error' ? 'failed' : 'queued'}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/40">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${state.status === 'error' ? 'bg-red-500' : 'bg-accent'}`}
          style={{ width: `${state.status === 'error' ? 100 : pct}%` }}
        />
      </div>
      {active && (rate > 0 || left) && (
        <p className="mt-1 tabular-nums text-[11px] text-neutral-600">
          {rate > 0 && `${formatBytes(rate)}/s`}{rate > 0 && left ? ' · ' : ''}{left}
        </p>
      )}
      {state.error && <p className="mt-1.5 text-xs text-red-300">{state.error}</p>}
    </div>
  );
}

export default function DriveProgress({ entry }) {
  const videoState = useAssetState(entry?.video);
  const audioState = useAssetState(entry?.audio);

  const fromDrive = [entry?.video, entry?.audio].filter((a) => a?.origin === 'drive');
  if (fromDrive.length === 0) return null;

  const states = [
    entry?.video?.origin === 'drive' ? videoState : null,
    entry?.audio?.origin === 'drive' ? audioState : null,
  ].filter(Boolean);
  if (states.every((s) => s.status === 'ready')) return null;

  const failed = states.some((s) => s.status === 'error');

  return (
    <section className="mt-4 rounded-xl border border-edge bg-panel px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-white">
          {failed ? 'Could not fetch from Drive' : 'Copying from Drive'}
        </h3>
        <span className="text-[11px] text-neutral-600">first time only</span>
      </div>
      {!failed && (
        <p className="mt-1 text-xs text-neutral-500">
          Drive does not serve partial reads to a browser, so the file is copied to this device
          once. After that it plays instantly, offline, and survives a reload.
        </p>
      )}
      <div className="mt-2">
        <Row asset={entry?.video} state={videoState} />
        <Row asset={entry?.audio} state={audioState} />
      </div>
      {failed && (
        <p className="mt-2 text-xs text-neutral-500">
          Nothing partial is kept, so retrying starts clean. Drive has no resumable download for
          browsers — there are no ranged reads to resume with.
        </p>
      )}
    </section>
  );
}

export { useAssetState };
