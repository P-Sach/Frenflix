import { useEffect } from 'react';
import { useLibrary } from '../context/LibraryContext';
import { formatBytes } from '../lib/sources';

/**
 * Manual fallback for when the name matcher declines to guess. The matcher is
 * allowed to give up; it is not allowed to pair the wrong files.
 */
export default function PairPickerModal({ entry, onClose }) {
  const { looseAudios, linkPair, unlinkPair } = useLibrary();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!entry) return null;

  const choices = entry.audio ? [entry.audio, ...looseAudios] : looseAudios;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-edge bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose an audio track for ${entry.title}`}
      >
        <h2 className="text-lg font-semibold text-white">Pair audio</h2>
        <p className="mt-1 truncate text-sm text-neutral-400" title={entry.video.name}>
          {entry.video.name}
        </p>

        <div className="mt-5 max-h-72 space-y-2 overflow-y-auto">
          <button
            type="button"
            onClick={() => { unlinkPair(entry.id); onClose(); }}
            className={[
              'w-full rounded-lg border px-4 py-3 text-left transition-colors',
              !entry.audio ? 'border-accent bg-accent/10' : 'border-edge hover:border-neutral-500',
            ].join(' ')}
          >
            <span className="text-sm text-white">Use the video&rsquo;s own audio</span>
            <span className="block text-xs text-neutral-500">No separate track</span>
          </button>

          {choices.map((audio) => {
            const selected = entry.audio?.id === audio.id;
            return (
              <button
                key={audio.id}
                type="button"
                onClick={() => { linkPair(entry.id, audio.id); onClose(); }}
                className={[
                  'w-full rounded-lg border px-4 py-3 text-left transition-colors',
                  selected ? 'border-accent bg-accent/10' : 'border-edge hover:border-neutral-500',
                ].join(' ')}
              >
                <span className="block truncate text-sm text-white" title={audio.name}>{audio.name}</span>
                <span className="block text-xs text-neutral-500">
                  {formatBytes(audio.size)}{selected ? ' · currently paired' : ''}
                </span>
              </button>
            );
          })}

          {choices.length === 0 && (
            <p className="rounded-lg border border-edge px-4 py-6 text-center text-sm text-neutral-500">
              No unpaired audio files. Drop one in and it will show up here.
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-300 hover:text-white">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
