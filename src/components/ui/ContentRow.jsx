import { useCallback, useEffect, useRef, useState } from 'react';
import { BiChevronLeft, BiChevronRight } from 'react-icons/bi';
import { FiArrowRight } from 'react-icons/fi';
import ContentCard from './ContentCard';

/**
 * A horizontal row of poster cards.
 *
 * Ported from WeFlix_v2's TrendingRow (MIT, Copyright (c) 2026 Phyo Min Thein)
 * — see ATTRIBUTION.md — including two details that are easy to miss and both
 * matter:
 *
 *   - The row is drag-scrollable, and a drag that moved more than a few pixels
 *     suppresses the click that follows it. Without that, every attempt to
 *     flick through a row opens whichever card you happened to grab.
 *   - The strip carries 24px of vertical padding pulled back by -16px of
 *     margin. That is not decoration: cards lift and scale on hover, and an
 *     `overflow-x` container clips anything that grows past its edge, so
 *     without the padding the hover effect is sliced off top and bottom.
 */
export default function ContentRow({
  title,
  entries,
  accent,
  progressFor,
  queue = [],
  onQueue,
  onRemove,
  onSeeAll,
  seeAllLabel = 'See all',
  emptyNote,
}) {
  const rowRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0, moved: false });
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  const scroll = (dir) => {
    rowRef.current?.scrollBy({ left: dir * 580, behavior: 'smooth' });
  };

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const el = rowRef.current;
    if (!el) return;
    dragRef.current = { active: true, startX: e.pageX, startScrollLeft: el.scrollLeft, moved: false };
    setDragging(true);
  }, []);

  const onMouseMove = useCallback((e) => {
    const el = rowRef.current;
    const drag = dragRef.current;
    if (!el || !drag.active) return;
    const delta = e.pageX - drag.startX;
    if (Math.abs(delta) > 4) drag.moved = true;
    el.scrollLeft = drag.startScrollLeft - delta;
  }, []);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    suppressClick.current = drag.moved;
    setDragging(false);
    setTimeout(() => { suppressClick.current = false; }, 0);
  }, []);

  useEffect(() => {
    window.addEventListener('mouseup', endDrag);
    return () => window.removeEventListener('mouseup', endDrag);
  }, [endDrag]);

  if (!entries.length && !emptyNote) return null;

  return (
    <section className="group/row mb-12" style={{ overflow: 'visible' }}>
      <div className="mb-5 flex items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3">
          {accent && <div className="h-6 w-1 rounded-full" style={{ background: accent }} />}
          <h2 className="text-lg font-bold tracking-tight text-white md:text-xl">{title}</h2>
          {entries.length > 0 && (
            <span className="text-xs font-semibold text-gray-600">{entries.length}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSeeAll && (
            <button
              type="button"
              onClick={onSeeAll}
              className="mr-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-500 transition-colors duration-200 hover:text-red-400"
            >
              {seeAllLabel} <FiArrowRight className="text-sm" />
            </button>
          )}
          {entries.length > 3 && (
            <div className="flex items-center gap-1 opacity-40 transition-opacity duration-200 group-hover/row:opacity-100">
              <button type="button" onClick={() => scroll(-1)} aria-label="Scroll left" className={arrowBtn}>
                <BiChevronLeft className="text-xl" />
              </button>
              <button type="button" onClick={() => scroll(1)} aria-label="Scroll right" className={arrowBtn}>
                <BiChevronRight className="text-xl" />
              </button>
            </div>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="px-4 text-sm text-gray-500 sm:px-6">{emptyNote}</p>
      ) : (
        <div
          ref={rowRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseLeave={endDrag}
          onClickCapture={(e) => {
            // A flick through the row must not open whichever card was grabbed.
            if (!suppressClick.current) return;
            e.preventDefault();
            e.stopPropagation();
          }}
          className={`hide-scrollbar flex select-none gap-3 overflow-x-auto px-4 sm:px-6 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ paddingTop: 24, paddingBottom: 24, marginTop: -16, marginBottom: -16 }}
        >
          {entries.map((entry) => (
            <div key={entry.id} className="relative shrink-0" style={{ width: 160 }}>
              <ContentCard
                entry={entry}
                progress={progressFor?.(entry)}
                queued={queue.includes(entry.id)}
                onQueue={onQueue}
                onRemove={onRemove}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const arrowBtn = 'flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] text-white transition-colors hover:bg-white/20';
