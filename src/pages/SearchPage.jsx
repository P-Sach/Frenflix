import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BiSearch } from 'react-icons/bi';
import ContentGrid from '../components/ui/ContentGrid';
import { useLibrary } from '../context/LibraryContext';
import { useWatchProgress } from '../lib/useWatchProgress';

/**
 * Search, with the category chips WeFlix_v2 puts under its search field
 * (MIT, Copyright (c) 2026 Phyo Min Thein) — see ATTRIBUTION.md.
 *
 * Theirs queries TMDB. Ours filters the files you already have, matching on
 * both the display title and the raw filename — the filename is where the
 * release detail lives, so "x265" or "hindi" should find something even though
 * neither ever appears on screen.
 */
const CHIPS = [
  { id: 'all', label: 'Everything' },
  { id: 'dubs', label: 'With dub tracks' },
  { id: 'multi', label: 'Multiple dubs' },
  { id: 'subs', label: 'With subtitles' },
  { id: 'drive', label: 'From Drive' },
  { id: 'local', label: 'On this device' },
  { id: 'warn', label: 'Needs attention' },
];

export default function SearchPage() {
  const { entries, queue, queueAdd, queueRemove, removeVideo } = useLibrary();
  const { forEntry } = useWatchProgress();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (needle && !`${e.title} ${e.video.name}`.toLowerCase().includes(needle)) return false;
      const tracks = e.audioTracks?.length || 0;
      if (chip === 'dubs' && tracks === 0) return false;
      if (chip === 'multi' && tracks < 2) return false;
      if (chip === 'subs' && e.subtitles.length === 0) return false;
      if (chip === 'drive' && !e.fromDrive) return false;
      if (chip === 'local' && e.fromDrive) return false;
      if (chip === 'warn' && e.warnings.length === 0) return false;
      return true;
    });
  }, [entries, q, chip]);

  return (
    <div className="py-10">
      <div className="px-4 sm:px-6">
        <div className="relative max-w-2xl">
          <BiSearch className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-gray-500" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your library by title or filename"
            aria-label="Search the library"
            className="w-full rounded-full border border-white/10 bg-card py-3.5 pl-12 pr-4 text-sm text-white placeholder:text-gray-600 focus:border-red-500/40 focus:outline-none"
          />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChip(c.id)}
              className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors ${
                chip === c.id
                  ? 'border-red-500/40 bg-red-600/20 text-red-300'
                  : 'border-white/[0.12] bg-white/[0.06] text-gray-400 hover:text-white'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <p className="mt-6 text-sm text-gray-500">
          {results.length} of {entries.length} title{entries.length === 1 ? '' : 's'}
        </p>
      </div>

      <div className="mt-6">
        {results.length === 0 ? (
          <p className="px-4 text-sm text-gray-500 sm:px-6">Nothing matched.</p>
        ) : (
          <ContentGrid
            entries={results}
            progressFor={forEntry}
            queue={queue}
            onQueue={(id) => (queue.includes(id) ? queueRemove(id) : queueAdd(id))}
            onRemove={removeVideo}
          />
        )}
      </div>
    </div>
  );
}
