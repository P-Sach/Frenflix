import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BiCalendar } from 'react-icons/bi';
import { FaInfoCircle, FaPlay } from 'react-icons/fa';
import { backdropFor } from '../../lib/thumbnails';
import { formatBytes, formatTime } from '../../lib/sources';

/** How long each slide holds. The indicator fills over exactly this. */
const INTERVAL = 7000;
const FADE_MS = 500;
const MAX_SLIDES = 5;

/**
 * The banner at the top of the library.
 *
 * Ported from WeFlix_v2's HeroBanner (MIT, Copyright (c) 2026 Phyo Min Thein)
 * — see ATTRIBUTION.md: the three stacked gradients over a full-bleed
 * backdrop, the metadata line, the pill buttons, the indicators that fill as
 * the slide dwells, and the thumbnail strip bottom-right.
 *
 * It leads with whatever is part-watched. The thing you were half way through
 * is the thing you most likely came back for, and a carousel that opens on
 * something else makes you wait seven seconds to find that out.
 */
/*
 * `isolate` on the root matters. The indicators and the thumbnail strip are
 * z-20 inside this banner, and `position: relative` with `z-index: auto` does
 * NOT create a stacking context — so without isolation those children compete
 * directly with the page content below, which is pulled up under the banner
 * and sits at z-10. They won, and became an invisible lid over the first row's
 * controls. Caught by a click that kept being intercepted by an <img>.
 */
/*
 * Play/Resume is a <Link>, not a button with a handler.
 *
 * It used to take an `onOpen` callback, the library page never passed one, and
 * the headline control of the whole interface did nothing when clicked. A
 * route is a route: a link cannot be wired up wrong, it cannot be forgotten by
 * the next caller, and it ctrl-clicks and middle-clicks like everything else
 * on the page. Same reasoning as ContentCard's stretched anchor.
 */
export default function HeroBanner({ entries, progressFor }) {
  const slides = useMemo(() => {
    const scored = entries.map((e) => ({ entry: e, progress: progressFor?.(e) }));
    const resuming = scored
      .filter((x) => x.progress?.canResume)
      .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0));
    const rest = scored.filter((x) => !x.progress?.canResume).reverse();
    return [...resuming, ...rest].slice(0, MAX_SLIDES);
  }, [entries, progressFor]);

  const [active, setActive] = useState(0);
  const [fade, setFade] = useState(true);
  const [barKey, setBarKey] = useState(0);
  const [art, setArt] = useState({});
  const timer = useRef(null);

  const current = slides[Math.min(active, slides.length - 1)];

  // Art for every slide, so the thumbnail strip is populated too.
  useEffect(() => {
    let cancelled = false;
    slides.forEach(({ entry }) => {
      backdropFor(entry).then((url) => {
        if (!cancelled && url) setArt((prev) => (prev[entry.id] ? prev : { ...prev, [entry.id]: url }));
      });
    });
    return () => { cancelled = true; };
  }, [slides]);

  const goTo = useCallback((i) => {
    setFade(false);
    setTimeout(() => {
      setActive(i);
      setFade(true);
      setBarKey((k) => k + 1);
    }, FADE_MS * 0.4);
  }, []);

  useEffect(() => {
    if (slides.length < 2) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => goTo((active + 1) % slides.length), INTERVAL);
    return () => clearTimeout(timer.current);
  }, [active, slides.length, goTo, barKey]);

  useEffect(() => { setActive(0); }, [slides.length]);

  if (!current) return null;

  const { entry, progress } = current;
  const tracks = entry.audioTracks?.length || 0;
  const facts = [
    tracks > 1 && `${tracks} audio tracks`,
    tracks === 1 && 'Dub paired',
    entry.subtitles.length > 0 && `${entry.subtitles.length} subtitle tracks`,
    entry.fromDrive && 'Google Drive',
  ].filter(Boolean);

  return (
    <div className="relative isolate h-[58vh] w-full select-none overflow-hidden bg-black md:h-[72vh]">
      <div className={`absolute inset-0 transition-opacity duration-500 ${fade ? 'opacity-100' : 'opacity-0'}`}>
        {art[entry.id] && (
          <img src={art[entry.id]} alt="" className="h-full w-full object-cover object-center" />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-transparent to-black/30" />
        <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-black/60 to-transparent" />
      </div>

      <div
        className={`relative z-10 flex h-full max-w-2xl flex-col justify-end px-6 pb-20 transition-opacity duration-500 md:justify-center md:px-14 md:pb-16 ${
          fade ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-600/20 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-red-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
            {progress?.canResume ? 'Continue' : 'In your library'}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
            {entry.fromDrive ? 'Drive' : 'This device'}
          </span>
        </div>

        <h2 className="mb-3 text-4xl font-black leading-[1.05] tracking-tight text-white drop-shadow-[0_2px_20px_rgba(0,0,0,0.8)] md:text-5xl lg:text-[3.25rem]">
          {entry.title}
        </h2>

        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          {progress?.duration > 0 && (
            <span className="flex items-center gap-1.5 text-sm font-bold text-yellow-400">
              <BiCalendar className="text-xs text-yellow-400/70" />
              {formatTime(progress.duration)}
            </span>
          )}
          <span className="text-sm text-gray-400">{formatBytes(entry.video.size)}</span>
          {facts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {facts.map((f) => (
                <span
                  key={f}
                  className="rounded-full border border-white/[0.12] bg-white/[0.09] px-2.5 py-0.5 text-[11px] font-semibold text-gray-300"
                >
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>

        <p className="mb-7 hidden max-w-lg truncate text-sm leading-relaxed text-gray-300/85 sm:block" title={entry.video.name}>
          {entry.video.name}
        </p>

        <div className="flex items-center gap-3">
          <Link
            to={`/watch/${entry.id}`}
            className="flex items-center gap-2.5 rounded-full bg-accent px-7 py-3 text-sm font-bold text-white shadow-lg shadow-red-700/40 transition-all duration-200 hover:scale-105 hover:bg-red-500"
          >
            <FaPlay className="text-xs" />
            {progress?.canResume ? 'Resume' : 'Play now'}
          </Link>
          {progress?.canResume && (
            <span className="flex items-center gap-2 rounded-full border border-white/[0.15] bg-white/[0.1] px-6 py-3 text-sm font-semibold text-white backdrop-blur">
              <FaInfoCircle className="text-sm" />
              {Math.round((progress.fraction || 0) * 100)}% watched
            </span>
          )}
        </div>
      </div>

      {slides.length > 1 && (
        <div className="absolute bottom-10 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
          {slides.map((s, i) => (
            <button
              key={s.entry.id}
              type="button"
              onClick={() => { if (i !== active) goTo(i); }}
              aria-label={`Show ${s.entry.title}`}
              className="relative overflow-hidden rounded-full transition-all duration-300"
              style={{ width: i === active ? 28 : 8, height: 8 }}
            >
              <span className="absolute inset-0 rounded-full bg-gray-600/50" />
              {i === active ? (
                <span
                  key={barKey}
                  className="absolute inset-y-0 left-0 rounded-full bg-red-500"
                  style={{ animation: `fillBar ${INTERVAL}ms linear forwards` }}
                />
              ) : (
                <span className="absolute inset-0 rounded-full bg-gray-500/50 transition-colors hover:bg-gray-400/60" />
              )}
            </button>
          ))}
        </div>
      )}

      {slides.length > 1 && (
        <div className="absolute bottom-10 right-6 z-20 hidden gap-2 lg:flex">
          {slides.map((s, i) => (
            <button
              key={s.entry.id}
              type="button"
              onClick={() => { if (i !== active) goTo(i); }}
              aria-label={s.entry.title}
              className={`relative h-[50px] w-[80px] overflow-hidden rounded-lg ring-1 transition-all duration-200 ${
                i === active ? 'scale-105 opacity-100 ring-red-500' : 'opacity-45 ring-white/10 hover:opacity-75'
              }`}
            >
              {art[s.entry.id] ? (
                <img src={art[s.entry.id]} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="block h-full w-full bg-gray-800" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
