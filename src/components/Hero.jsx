import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { posterFor } from '../lib/thumbnails';
import { formatTime } from '../lib/sources';

/**
 * The banner at the top.
 *
 * It features whatever is part-watched, falling back to the newest title —
 * because the thing you were half way through is the thing you most likely
 * came back for. The backdrop is the same captured frame as the card art,
 * blown up and darkened hard enough that white text stays legible over an
 * arbitrary bright frame.
 */
export default function Hero({ entries, progressFor }) {
  const inProgress = entries
    .map((e) => ({ entry: e, progress: progressFor?.(e) }))
    .filter((x) => x.progress?.canResume)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))[0];

  const featured = inProgress?.entry || entries[entries.length - 1];
  const progress = inProgress?.progress || progressFor?.(featured);
  const [art, setArt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    if (featured) posterFor(featured).then((url) => { if (!cancelled) setArt(url); });
    return () => { cancelled = true; };
  }, [featured]);

  if (!featured) return null;

  return (
    <div className="relative isolate overflow-hidden border-b border-edge">
      {art && (
        <img
          src={art}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 -z-10 h-full w-full scale-105 object-cover opacity-45 blur-[2px]"
        />
      )}
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink via-ink/85 to-ink/40" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-32 bg-gradient-to-t from-ink to-transparent" />

      <div className="mx-auto max-w-7xl px-6 py-14 sm:py-20">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">
          {progress?.canResume ? 'Continue watching' : 'Latest in your library'}
        </p>
        <h2 className="mt-3 max-w-2xl text-3xl font-bold leading-tight text-white sm:text-5xl">
          {featured.title}
        </h2>
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-400">
          {featured.audioTracks.length > 1 && <span>{featured.audioTracks.length} audio tracks</span>}
          {featured.subtitles.length > 0 && <span>{featured.subtitles.length} subtitle tracks</span>}
          {featured.fromDrive && <span className="text-sky-300">from Drive</span>}
          {progress?.canResume && <span>{formatTime(progress.position)} in</span>}
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            to={`/watch/${featured.id}`}
            className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200"
          >
            {progress?.canResume ? '▶ Resume' : '▶ Play'}
          </Link>
          {progress?.canResume && (
            <span className="text-xs text-neutral-500">
              {Math.round((progress.fraction || 0) * 100)}% watched
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
