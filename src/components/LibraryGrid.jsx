import PosterCard from './PosterCard';
import { useLibrary } from '../context/LibraryContext';

export default function LibraryGrid({ entries, progressFor, onPair }) {
  const { removeVideo, queueAdd, queue } = useLibrary();

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map((entry) => (
        <div key={entry.id}>
          <PosterCard
            entry={entry}
            progress={progressFor?.(entry)}
            onQueue={queueAdd}
            onRemove={removeVideo}
            queued={queue.includes(entry.id)}
          />
          {onPair && (
            <button
              type="button"
              onClick={() => onPair(entry)}
              className="mt-1 text-[11px] text-neutral-500 underline hover:text-white"
            >
              {entry.audio ? 'change audio' : 'pair audio'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
