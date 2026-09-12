import ContentCard from './ContentCard';

/**
 * The poster grid. Ported from WeFlix_v2's ContentGrid
 * (MIT, Copyright (c) 2026 Phyo Min Thein) — see ATTRIBUTION.md.
 *
 * Theirs paginates TMDB forever on scroll. A library is a finite set of files
 * you already have, so there is nothing to page in: the grid just renders it.
 */
export default function ContentGrid({ entries, progressFor, queue = [], onQueue, onRemove }) {
  if (!entries.length) return null;

  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-6 px-4 sm:px-6 xs:grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
      {entries.map((entry) => (
        <ContentCard
          key={entry.id}
          entry={entry}
          progress={progressFor?.(entry)}
          queued={queue.includes(entry.id)}
          onQueue={onQueue}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
