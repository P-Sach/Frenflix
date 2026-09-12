import { useRef } from 'react';
import PosterCard from './PosterCard';

/**
 * A horizontally scrolling row of cards.
 *
 * Native overflow scrolling with snap points rather than a carousel library:
 * it works with a trackpad, a touch screen, a scrollbar and the keyboard
 * without any of them being special-cased, and the arrows are an addition on
 * top rather than the only way through.
 */
export default function PosterRow({ title, entries, progressFor, onQueue, onRemove, queue = [], action }) {
  const strip = useRef(null);

  if (entries.length === 0) return null;

  const nudge = (dir) => {
    const el = strip.current;
    if (el) el.scrollBy({ left: dir * Math.max(320, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <div className="flex items-center gap-3">
          {action}
          {entries.length > 3 && (
            <span className="hidden gap-1 sm:flex">
              <button type="button" onClick={() => nudge(-1)} aria-label="Scroll left" className={arrow}>‹</button>
              <button type="button" onClick={() => nudge(1)} aria-label="Scroll right" className={arrow}>›</button>
            </span>
          )}
        </div>
      </div>

      <div
        ref={strip}
        className="-mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {entries.map((entry) => (
          <div key={entry.id} className="w-[248px] shrink-0 snap-start sm:w-[288px]">
            <PosterCard
              entry={entry}
              progress={progressFor?.(entry)}
              onQueue={onQueue}
              onRemove={onRemove}
              queued={queue.includes(entry.id)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

const arrow = 'grid h-7 w-7 place-items-center rounded-full border border-edge text-neutral-400 hover:border-neutral-500 hover:text-white';
