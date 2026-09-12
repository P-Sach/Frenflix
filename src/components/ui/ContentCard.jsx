import { memo, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FaCheck, FaPlay, FaPlus, FaTrash } from 'react-icons/fa';
import { motion } from 'framer-motion';
import { posterFor } from '../../lib/thumbnails';
import { formatTime } from '../../lib/sources';

/**
 * A title, as a poster card.
 *
 * Ported from WeFlix_v2's ContentCard (MIT, Copyright (c) 2026 Phyo Min Thein)
 * — see ATTRIBUTION.md. The structure is theirs: 2:3 poster, spring hover lift,
 * corner badges, a dimming overlay with a red play disc, and the title block
 * below on the card's own surface.
 *
 * One deliberate departure: navigation is a real <a>, stretched across the
 * poster, rather than their div with `role="button"` and an onClick. A card
 * that goes somewhere should be a link — middle-click, open-in-new-tab and
 * keyboard activation then all work without being reimplemented. The action
 * buttons sit above it in z-order rather than inside it, because a button
 * nested in an anchor is invalid and behaves unpredictably.
 *
 * What else changed is what the badges *say*. Theirs read a TMDB score and
 * MOVIE/SERIES; a library of files has neither. Ours carry the things that
 * actually distinguish one file from another here: how long it runs, whether
 * it came from Drive, and how many dub tracks are paired to it. Keeping the
 * badge shapes while inventing scores for them would have been the worse kind
 * of faithful.
 */
const ContentCard = memo(({
  entry,
  progress,
  queued = false,
  onQueue,
  onRemove,
  className = '',
}) => {
  const [art, setArt] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    setLoaded(false);
    setSettled(false);
    posterFor(entry).then((url) => {
      if (cancelled) return;
      setArt(url);
      setSettled(true);
    });
    return () => { cancelled = true; };
  }, [entry]);

  const tracks = entry.audioTracks?.length || 0;
  const fraction = progress?.fraction || 0;

  return (
    <motion.article
      whileHover={{ scale: 1.05, y: -4 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      className={`group relative z-10 w-full cursor-pointer transition-shadow duration-200 ${className}`}
    >
      <div className="relative z-20 flex h-full w-full flex-col overflow-hidden rounded-xl bg-card ring-1 ring-white/5 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-white/20">
        <div className="relative aspect-[2/3] w-full bg-shade">
          {/* The stretched link: one real anchor covering the poster. */}
          <Link
            to={`/watch/${entry.id}`}
            aria-label={`Play ${entry.title}`}
            className="absolute inset-0 z-10"
            draggable={false}
          />

          {!settled && (
            <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-white/5 to-white/[0.02]" />
          )}

          {art && (
            <img
              src={art}
              alt=""
              loading="lazy"
              className={`h-full w-full object-cover transition-all duration-700 ease-out ${
                loaded ? 'scale-100 opacity-100 blur-0' : 'scale-105 opacity-0 blur-md'
              }`}
              onLoad={() => setLoaded(true)}
            />
          )}

          {settled && !art && (
            <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-gray-800 to-gray-900 px-4 text-center">
              <span className="text-xs text-gray-500">no preview</span>
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />

          {/* Runtime, where their score badge sat. */}
          {progress?.duration > 0 && (
            <div className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-gray-300 backdrop-blur-sm">
              {formatTime(progress.duration)}
            </div>
          )}

          {/* Source, where their MOVIE/SERIES badge sat. */}
          <div
            className={`pointer-events-none absolute left-2 top-2 rounded-sm px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-white ${
              entry.fromDrive ? 'bg-sky-600' : 'bg-accent'
            }`}
          >
            {entry.fromDrive ? 'Drive' : 'Local'}
          </div>

          {entry.warnings.length > 0 && (
            <div
              className="absolute right-2 top-9 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-amber-300 backdrop-blur-sm"
              title={entry.warnings.join(' · ')}
            >
              ⚠
            </div>
          )}

          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-3 bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <div className="flex h-12 w-12 scale-75 transform items-center justify-center rounded-full bg-accent shadow-lg shadow-red-700/50 transition-transform duration-200 group-hover:scale-100">
              <FaPlay className="ml-0.5 text-sm text-white" />
            </div>

            {onQueue && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onQueue(entry.id); }}
                title={queued ? 'Remove from queue' : 'Add to queue'}
                aria-label={queued ? `Remove ${entry.title} from the queue` : `Add ${entry.title} to the queue`}
                className={`pointer-events-auto flex h-12 w-12 scale-75 transform items-center justify-center rounded-full shadow-lg transition-all duration-200 group-hover:scale-100 ${
                  queued
                    ? 'bg-accent shadow-red-700/50'
                    : 'border border-white/30 bg-white/25 backdrop-blur-sm hover:bg-white/35'
                }`}
              >
                {queued ? <FaCheck className="text-sm text-white" /> : <FaPlus className="text-sm text-white" />}
              </button>
            )}

            {onRemove && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}
                aria-label={`Remove ${entry.title} from the library`}
                className="pointer-events-auto flex h-12 w-12 scale-75 transform items-center justify-center rounded-full border border-white/20 bg-black/60 transition-all duration-200 hover:border-red-500 hover:bg-accent/90 group-hover:scale-100"
              >
                <FaTrash className="text-sm text-white" />
              </button>
            )}
          </div>

          {fraction > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-1 bg-white/20">
              <div className="h-full bg-accent" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          )}
        </div>

        <div className="relative z-20 shrink-0 bg-card px-2.5 pb-2.5 pt-2">
          <p className="line-clamp-1 text-[13px] font-semibold leading-tight text-white" title={entry.title}>
            {entry.title}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            {tracks > 1 ? `${tracks} audio tracks` : tracks === 1 ? 'Dub paired' : 'Embedded audio'}
            {entry.subtitles.length > 0 && ` • ${entry.subtitles.length} subs`}
          </p>
        </div>
      </div>
    </motion.article>
  );
});

ContentCard.displayName = 'ContentCard';
export default ContentCard;
