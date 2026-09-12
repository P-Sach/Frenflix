import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BiChevronLeft, BiChevronRight } from 'react-icons/bi';
import { FaArrowLeft, FaPlus } from 'react-icons/fa';
import PairPickerModal from '../components/PairPickerModal';
import Player from '../components/Player';
import { useLibrary } from '../context/LibraryContext';
import { backdropFor } from '../lib/thumbnails';
import { formatBytes } from '../lib/sources';

/**
 * The detail page. Laid out like WeFlix_v2's MovieDetails
 * (MIT, Copyright (c) 2026 Phyo Min Thein) — see ATTRIBUTION.md: a full-bleed
 * backdrop behind the title block, the player below it, then the metadata.
 *
 * The backdrop is this title's own captured frame, so the page is tinted by
 * the film it is about even before anything plays.
 */
export default function WatchPage() {
  const { id } = useParams();
  const {
    getEntry, addFiles, linkSubtitle, linkPair, nextAfter, prevBefore,
    queue, queueRemove, queueAdd,
  } = useLibrary();
  const navigate = useNavigate();
  const entry = getEntry(id);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [art, setArt] = useState(null);
  const subInputRef = useRef(null);

  const nextId = nextAfter(id);
  const prevId = prevBefore(id);
  const nextEntry = nextId ? getEntry(nextId) : null;

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    setError(null);
    if (entry) backdropFor(entry).then((url) => { if (!cancelled) setArt(url); });
    return () => { cancelled = true; };
  }, [entry]);

  const onError = useCallback((err) => {
    setError(err?.message || 'The browser could not decode this file.');
  }, []);

  const handleEnded = useCallback(() => {
    if (!autoAdvance || !nextId) return;
    navigate(`/watch/${nextId}`);
  }, [autoAdvance, nextId, navigate]);

  /** Files dropped here belong to *this* title, whatever they are called. */
  const attach = useCallback((files) => {
    if (!entry) return;
    const added = addFiles(files);
    added.subtitles.forEach((s) => linkSubtitle(entry.id, s.id));
    if (added.audios.length > 0) linkPair(entry.id, added.audios[0].id);
  }, [entry, addFiles, linkSubtitle, linkPair]);

  if (!entry) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h1 className="text-2xl font-black text-white">Nothing to play here</h1>
        <p className="mt-2 text-sm text-gray-500">
          Local files are held in memory, so a page reload empties the library.
        </p>
        <Link to="/" className="mt-8 inline-block rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-white">
          Back to the library
        </Link>
      </div>
    );
  }

  const tracks = entry.audioTracks?.length || 0;
  const chips = [
    tracks > 1 && `${tracks} audio tracks`,
    tracks === 1 && 'Dub paired',
    entry.subtitles.length > 0 && `${entry.subtitles.length} subtitle tracks`,
    entry.fromDrive ? 'Google Drive' : 'This device',
    formatBytes(entry.video.size),
  ].filter(Boolean);

  return (
    <div
      className="relative min-h-screen"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}
    >
      {/* Full-bleed backdrop behind the header. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
        {art && <img src={art} alt="" className="h-full w-full object-cover opacity-30" />}
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-ink/80 to-ink" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-gray-400 transition-colors hover:text-white">
          <FaArrowLeft className="text-xs" /> Library
        </Link>

        <h1 className="mt-5 text-3xl font-black leading-tight tracking-tight text-white md:text-4xl">
          {entry.title}
        </h1>
        <p className="mt-1 truncate text-sm text-gray-500" title={entry.video.name}>{entry.video.name}</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c} className="rounded-full border border-white/[0.12] bg-white/[0.09] px-2.5 py-0.5 text-[11px] font-semibold text-gray-300">
              {c}
            </span>
          ))}
        </div>

        {dragging && (
          <p className="mt-5 rounded-xl border-2 border-dashed border-red-500 bg-red-600/10 px-4 py-3 text-center text-sm font-semibold text-white">
            Drop to attach to this title
          </p>
        )}

        {/* No wrapper ring: the player already rounds its own frame, and a
            second border here enclosed the sync panels too, which made them
            look like part of the video. */}
        <div className="mt-7">
          <Player entry={entry} onError={onError} onEnded={handleEnded} />
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-red-500/40 bg-red-600/10 px-4 py-3 text-sm text-red-300">
            {error} Containers like .mkv and codecs like AC-3/DTS are not supported by browsers —
            remux to MP4/WebM with AAC or Opus first.
          </p>
        )}

        {entry.warnings.map((w) => (
          <p key={w} className="mt-3 text-sm text-amber-400">⚠ {w}</p>
        ))}

        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-card px-4 py-3">
          <button
            type="button"
            disabled={!prevId}
            onClick={() => navigate(`/watch/${prevId}`)}
            className={navBtn}
          >
            <BiChevronLeft className="text-lg" /> Previous
          </button>
          <button
            type="button"
            disabled={!nextId}
            onClick={() => navigate(`/watch/${nextId}`)}
            className={navBtn}
          >
            Next <BiChevronRight className="text-lg" />
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} className="accent-accent" />
            Play next automatically
          </label>
          <button
            type="button"
            onClick={() => (queue.includes(entry.id) ? queueRemove(entry.id) : queueAdd(entry.id))}
            className="ml-auto flex items-center gap-2 rounded-full border border-white/[0.15] bg-white/[0.08] px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-white/[0.16]"
          >
            <FaPlus className="text-[10px]" />
            {queue.includes(entry.id) ? 'Queued' : 'Add to queue'}
          </button>
          {nextEntry && (
            <span className="w-full truncate text-xs text-gray-600">up next: {nextEntry.title}</span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-widest text-gray-600">Audio</p>
            <p className="truncate text-sm text-gray-300" title={entry.audio?.name}>
              {entry.audio ? entry.audio.name : "The video file's own track"}
            </p>
          </div>
          <button type="button" onClick={() => setPairing(entry)} className={smallBtn}>
            {entry.audio ? 'Change audio' : 'Pair a track'}
          </button>
          <button type="button" onClick={() => subInputRef.current?.click()} className={smallBtn}>
            Add subtitle
          </button>
          <input
            ref={subInputRef}
            type="file"
            multiple
            accept=".srt,.vtt,.ass,.ssa,.sub,.sbv,text/vtt"
            className="hidden"
            onChange={(e) => { attach(e.target.files); e.target.value = ''; }}
          />
        </div>

        {queue.length > 0 && (
          <section className="mt-4 rounded-xl border border-white/10 bg-card px-4 py-3">
            <h2 className="text-[11px] uppercase tracking-widest text-gray-600">Queue ({queue.length})</h2>
            <ol className="mt-2 space-y-1">
              {queue.map((qid, i) => {
                const q = getEntry(qid);
                if (!q) return null;
                return (
                  <li key={qid} className="flex items-center gap-3 text-sm">
                    <span className="w-5 shrink-0 text-right text-xs text-gray-600">{i + 1}</span>
                    <Link
                      to={`/watch/${qid}`}
                      className={`min-w-0 flex-1 truncate ${qid === id ? 'text-red-400' : 'text-gray-300 hover:text-white'}`}
                    >
                      {q.title}
                    </Link>
                    <button
                      type="button"
                      onClick={() => queueRemove(qid)}
                      aria-label={`Remove ${q.title} from the queue`}
                      className="shrink-0 text-gray-600 hover:text-red-400"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>

      <PairPickerModal entry={pairing} onClose={() => setPairing(null)} />
    </div>
  );
}

const navBtn = 'flex items-center gap-1 rounded-full border border-white/[0.15] bg-white/[0.06] px-4 py-1.5 text-sm font-semibold text-gray-300 transition-colors hover:bg-white/[0.14] hover:text-white disabled:opacity-30';
const smallBtn = 'rounded-full border border-white/[0.15] bg-white/[0.08] px-4 py-1.5 text-sm font-semibold text-gray-300 transition-colors hover:bg-white/[0.16] hover:text-white';
