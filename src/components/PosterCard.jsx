import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { posterFor } from '../lib/thumbnails';
import { formatBytes, formatTime } from '../lib/sources';

/**
 * One title, as a card.
 *
 * The art is a frame from the file itself. Cards are 16:9 rather than the 2:3
 * of a cinema poster for exactly that reason — a video frame cropped to
 * portrait is a worse picture than the frame, and pretending to have posters
 * we do not have is how a library of home video ends up looking broken.
 */
export default function PosterCard({ entry, progress, onQueue, onRemove, queued }) {
  const [art, setArt] = useState(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    setTried(false);
    posterFor(entry).then((url) => {
      if (cancelled) return;
      setArt(url);
      setTried(true);
    });
    return () => { cancelled = true; };
  }, [entry]);

  const fraction = progress?.fraction || 0;
  const tracks = entry.audioTracks?.length || 0;

  return (
    <article className="group relative">
      <Link
        to={`/watch/${entry.id}`}
        className="block overflow-hidden rounded-lg bg-neutral-900 ring-1 ring-white/5 transition duration-200 group-hover:ring-white/25"
      >
        <div className="relative aspect-video">
          {art ? (
            <img src={art} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="grid h-full w-full place-items-center bg-gradient-to-br from-neutral-800 to-neutral-900">
              <span className="px-3 text-center text-xs text-neutral-600">
                {tried ? 'no preview' : 'reading frame…'}
              </span>
            </div>
          )}

          {/* Hover scrim with the play affordance. */}
          <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/85 via-black/10 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="m-3 rounded-full bg-white/95 px-3 py-1 text-xs font-semibold text-black">
              {progress?.canResume ? 'Resume' : 'Play'}
            </span>
          </div>

          {entry.fromDrive && (
            <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
              Drive
            </span>
          )}
          {entry.warnings.length > 0 && (
            <span
              className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-amber-300"
              title={entry.warnings.join(' · ')}
            >
              ⚠
            </span>
          )}

          {fraction > 0 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
              <div className="h-full bg-accent" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          )}
        </div>
      </Link>

      <div className="mt-2">
        <h3 className="truncate text-sm font-medium text-neutral-100" title={entry.title}>{entry.title}</h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-500">
          {tracks > 1 && <span className="text-violet-300">{tracks} audio tracks</span>}
          {tracks === 1 && <span>dub paired</span>}
          {entry.subtitles.length > 0 && <span className="text-emerald-400/80">{entry.subtitles.length} subs</span>}
          {progress?.canResume && <span>{formatTime(progress.position)} watched</span>}
          {!tracks && !entry.subtitles.length && !progress?.canResume && (
            <span>{formatBytes(entry.video.size)}</span>
          )}
        </p>
      </div>

      {/* Row actions, kept out of the Link so they are not a navigation. */}
      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {onQueue && (
          <button
            type="button"
            onClick={() => onQueue(entry.id)}
            title={queued ? 'Already queued' : 'Add to queue'}
            aria-label={queued ? `${entry.title} is queued` : `Add ${entry.title} to the queue`}
            className={`grid h-6 w-6 place-items-center rounded bg-black/70 text-xs ${queued ? 'text-accent' : 'text-neutral-300 hover:text-white'}`}
          >
            {queued ? '✓' : '+'}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(entry.id)}
            aria-label={`Remove ${entry.title}`}
            className="grid h-6 w-6 place-items-center rounded bg-black/70 text-xs text-neutral-300 hover:text-accent"
          >
            ×
          </button>
        )}
      </div>
    </article>
  );
}
