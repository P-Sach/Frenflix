import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ContentGrid from '../components/ui/ContentGrid';
import PairPickerModal from '../components/PairPickerModal';
import { useLibrary } from '../context/LibraryContext';
import { formatBytes } from '../lib/sources';
import { useWatchProgress } from '../lib/useWatchProgress';

/**
 * The sidebar's filtered views. WeFlix_v2 routes its rail at TMDB genres; a
 * library of files has none, so these are the questions you actually ask of
 * your own files instead.
 */
const VIEWS = {
  continue: { title: 'Continue watching', note: 'Titles you are part way through.' },
  queue: { title: 'Up next', note: 'What plays after the current title ends.' },
  drive: { title: 'From Google Drive', note: 'Pulled from Drive and cached on this device.' },
  unpaired: { title: 'Unpaired files', note: 'Audio and subtitle files no title matched by name.' },
};

export default function FilterPage() {
  const { view } = useParams();
  const navigate = useNavigate();
  const {
    entries, queue, queueAdd, queueRemove, removeVideo, looseAudios, looseSubtitles,
    removeAudio, removeSubtitle,
  } = useLibrary();
  const { forEntry } = useWatchProgress();
  const [pairing, setPairing] = useState(null);

  const meta = VIEWS[view] || VIEWS.continue;
  const open = (entry) => navigate(`/watch/${entry.id}`);
  const toggleQueue = (id) => (queue.includes(id) ? queueRemove(id) : queueAdd(id));

  const shown = useMemo(() => {
    if (view === 'queue') return queue.map((id) => entries.find((e) => e.id === id)).filter(Boolean);
    if (view === 'drive') return entries.filter((e) => e.fromDrive);
    if (view === 'continue') {
      return entries
        .map((e) => ({ entry: e, progress: forEntry(e) }))
        .filter((x) => x.progress?.canResume)
        .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
        .map((x) => x.entry);
    }
    return [];
  }, [view, entries, queue, forEntry]);

  const loose = [...looseAudios, ...looseSubtitles];

  return (
    <div className="px-0 py-10">
      <header className="mb-8 px-4 sm:px-6">
        <h1 className="text-2xl font-black tracking-tight text-white md:text-3xl">{meta.title}</h1>
        <p className="mt-1 text-sm text-gray-500">{meta.note}</p>
      </header>

      {view === 'unpaired' ? (
        loose.length === 0 ? (
          <p className="px-4 text-sm text-gray-500 sm:px-6">Everything is paired.</p>
        ) : (
          <div className="px-4 sm:px-6">
            <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-card">
              {loose.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-300" title={a.name}>{a.name}</span>
                  <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-500">
                    {a.kind}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-gray-600">{formatBytes(a.size)}</span>
                  <button
                    type="button"
                    onClick={() => (a.kind === 'subtitle' ? removeSubtitle(a.id) : removeAudio(a.id))}
                    aria-label={`Remove ${a.name}`}
                    className="shrink-0 text-gray-600 hover:text-red-400"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-gray-500">
              Open a title and use <span className="text-gray-300">Change audio</span> to attach one by hand.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setPairing(e)}
                  className="truncate rounded-lg border border-white/10 bg-card px-3 py-2 text-left text-sm text-gray-300 hover:border-white/25 hover:text-white"
                >
                  {e.title}
                </button>
              ))}
            </div>
          </div>
        )
      ) : shown.length === 0 ? (
        <p className="px-4 text-sm text-gray-500 sm:px-6">Nothing here yet.</p>
      ) : (
        <ContentGrid
          entries={shown}
          progressFor={forEntry}
          queue={queue}
          onQueue={toggleQueue}
          onRemove={view === 'queue' ? queueRemove : removeVideo}
         
        />
      )}

      <PairPickerModal entry={pairing} onClose={() => setPairing(null)} />
    </div>
  );
}
