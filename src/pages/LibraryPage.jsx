import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import DropZone from '../components/DropZone';
import PairPickerModal from '../components/PairPickerModal';
import ContentGrid from '../components/ui/ContentGrid';
import ContentRow from '../components/ui/ContentRow';
import HeroBanner from '../components/ui/HeroBanner';
import { useLibrary } from '../context/LibraryContext';
import { cacheSupported, cacheUsage, evictAll } from '../lib/drive/cache';
import { forgetAllProgress } from '../lib/progress';
import { formatBytes } from '../lib/sources';
import { useWatchProgress } from '../lib/useWatchProgress';

export default function LibraryPage() {
  const {
    entries, looseAudios, looseSubtitles, rejected, dismissRejected, clearAll,
    queue, queueAdd, queueRemove, queueSet, queueClear, removeVideo,
  } = useLibrary();
  const { forEntry, refresh, count } = useWatchProgress();
  const { openDrive } = useOutletContext() || {};
  const navigate = useNavigate();
  const [pairing, setPairing] = useState(null);
  const [cached, setCached] = useState(0);

  useEffect(() => {
    if (!cacheSupported) return;
    cacheUsage().then(setCached).catch(() => {});
  }, [entries]);

  const open = (entry) => navigate(`/watch/${entry.id}`);
  const toggleQueue = (id) => (queue.includes(id) ? queueRemove(id) : queueAdd(id));

  const continueWatching = useMemo(() => entries
    .map((e) => ({ entry: e, progress: forEntry(e) }))
    .filter((x) => x.progress?.canResume)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
    .map((x) => x.entry), [entries, forEntry]);

  const queued = useMemo(
    () => queue.map((id) => entries.find((e) => e.id === id)).filter(Boolean),
    [queue, entries],
  );
  const recentlyAdded = useMemo(() => [...entries].reverse(), [entries]);
  const withDubs = useMemo(() => entries.filter((e) => (e.audioTracks?.length || 0) > 0), [entries]);

  const empty = entries.length === 0 && looseAudios.length === 0;

  if (empty) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-24">
        <h1 className="text-3xl font-black tracking-tight text-white">Your library is empty</h1>
        <p className="mt-2 text-sm text-gray-500">
          Drop a video, its dub track and a subtitle file — matching names pair on their own.
        </p>
        <div className="mt-8">
          <DropZone />
        </div>
        <button
          type="button"
          onClick={openDrive}
          className="mt-4 rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-500"
        >
          Add from Google Drive
        </button>
      </div>
    );
  }

  const rowProps = {
    progressFor: forEntry,
    queue,
    onQueue: toggleQueue,
  };

  return (
    <div>
      <HeroBanner entries={entries} progressFor={forEntry} />

      <div className="relative z-10 pt-10 pb-16">
        {rejected.length > 0 && (
          <div className="mx-4 mb-8 flex items-start justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 sm:mx-6">
            <p className="text-sm text-amber-300">
              Skipped {rejected.length} file{rejected.length === 1 ? '' : 's'} that
              {rejected.length === 1 ? " isn't" : " aren't"} video, audio or subtitles:{' '}
              <span className="text-amber-200/70">{rejected.slice(0, 3).join(', ')}</span>
              {rejected.length > 3 && ` and ${rejected.length - 3} more`}
            </p>
            <button type="button" onClick={dismissRejected} className="shrink-0 text-amber-400 hover:text-amber-200">×</button>
          </div>
        )}

        <ContentRow
          title="Continue watching"
          accent="#dc2626"
          entries={continueWatching}
          {...rowProps}
          onSeeAll={count > 0 ? () => forgetAllProgress().then(refresh) : undefined}
          seeAllLabel="Clear history"
        />

        <ContentRow
          title="Up next"
          accent="#8b5cf6"
          entries={queued}
          {...rowProps}
          onSeeAll={queue.length ? queueClear : undefined}
          seeAllLabel="Clear queue"
        />

        <ContentRow
          title="Recently added"
          accent="#0ea5e9"
          entries={recentlyAdded}
          {...rowProps}
          onSeeAll={entries.length > 1 ? () => queueSet(entries.map((e) => e.id)) : undefined}
          seeAllLabel="Queue all"
        />

        {withDubs.length > 0 && withDubs.length < entries.length && (
          <ContentRow title="With dub tracks" accent="#22c55e" entries={withDubs} {...rowProps} />
        )}

        <section className="mb-12">
          <div className="mb-5 flex items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="h-6 w-1 rounded-full bg-gray-600" />
              <h2 className="text-lg font-bold tracking-tight text-white md:text-xl">Everything</h2>
            </div>
            <button type="button" onClick={clearAll} className="text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-red-400">
              Clear library
            </button>
          </div>
          <ContentGrid entries={entries} progressFor={forEntry} queue={queue} onQueue={toggleQueue} onRemove={removeVideo} />
        </section>

        <div className="px-4 sm:px-6">
          <DropZone compact />
          {(looseAudios.length > 0 || looseSubtitles.length > 0) && (
            <p className="mt-4 text-sm text-gray-500">
              {looseAudios.length + looseSubtitles.length} file
              {looseAudios.length + looseSubtitles.length === 1 ? '' : 's'} matched no title.{' '}
              <button type="button" onClick={() => navigate('/unpaired')} className="underline hover:text-white">
                Pair them by hand
              </button>
            </p>
          )}
          {cached > 0 && (
            <p className="mt-4 text-xs text-gray-600">
              {formatBytes(cached)} of Drive files kept on this device so they play instantly.{' '}
              <button type="button" onClick={() => evictAll().then(() => setCached(0))} className="underline hover:text-gray-300">
                Delete the local copies
              </button>
            </p>
          )}
        </div>
      </div>

      <PairPickerModal entry={pairing} onClose={() => setPairing(null)} />
    </div>
  );
}
