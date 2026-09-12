import { useCallback, useState } from 'react';
import { FaFolderOpen, FaLock } from 'react-icons/fa';
import { useLibrary } from '../context/LibraryContext';
import { directoryPickerSupported } from '../lib/handles';

/**
 * The bar that gets the library's files back.
 *
 * A browser will not let a page keep a path, and it will not keep a file open
 * across a restart either. What it does allow is a capability — a
 * `FileSystemFileHandle` the user granted once — and re-granting it needs a
 * click. There is no way around the click, so the honest thing is to make it
 * one click, say plainly what it is for, and never pretend the library is
 * broken in the meantime: the titles, their dub pairings, their subtitle
 * tracks, their poster art and where you were up to are all already back on
 * screen by the time this appears.
 *
 * Two different situations, and they need different words:
 *
 *   locked  — there is a stored handle. One click and they play. If the
 *             library was pointed at a folder, that one click covers all of
 *             them, which is why the folder path is the one to push.
 *   missing — no handle, because the file came in through a file input or the
 *             browser has no File System Access API at all (Firefox, Safari).
 *             Nothing to re-grant; the file has to arrive again.
 */
export default function RestoreBar() {
  const { availability, restoreAccess, addFolder } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const restore = useCallback(async () => {
    setBusy(true);
    setNote('');
    try {
      const result = await restoreAccess();
      if (result?.remaining > 0 && result.granted > 0) {
        setNote(`${result.granted} back, ${result.remaining} to go — the browser allows one at a time.`);
      } else if (result?.granted === 0) {
        setNote('Nothing came back. The files may have moved, or the request was dismissed.');
      } else if (result?.added > 0) {
        setNote(`${result.added} new file${result.added === 1 ? '' : 's'} in that folder joined the library.`);
      }
    } finally {
      setBusy(false);
    }
  }, [restoreAccess]);

  if (availability.restoring || availability.waiting === 0) return null;

  const { locked, missing, folder } = availability;

  return (
    <div className="mx-4 mb-8 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 sm:mx-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FaLock className="shrink-0 text-xs text-amber-400" />
        <p className="min-w-0 flex-1 text-sm text-amber-200">
          {locked > 0 && (
            <>
              <b className="font-semibold">
                {locked} file{locked === 1 ? '' : 's'} {locked === 1 ? 'is' : 'are'} ready to reopen.
              </b>{' '}
              {folder
                ? 'Your folder needs permission again — one click covers all of them.'
                : 'Browsers do not keep file permissions across a restart.'}
            </>
          )}
          {locked > 0 && missing > 0 && ' '}
          {missing > 0 && (
            <>
              {missing} file{missing === 1 ? '' : 's'} {missing === 1 ? 'was' : 'were'} chosen in a way
              the browser cannot reopen — drop {missing === 1 ? 'it' : 'them'} in again, or point
              FrenFlix at the folder and it will not have to ask twice.
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {locked > 0 && (
            <button
              type="button"
              onClick={restore}
              disabled={busy}
              className="rounded-full bg-accent px-5 py-1.5 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              {busy ? 'Asking…' : folder ? 'Reopen the folder' : 'Reopen files'}
            </button>
          )}
          {directoryPickerSupported && (
            <button
              type="button"
              onClick={() => addFolder()}
              className="flex items-center gap-2 rounded-full border border-white/[0.18] bg-white/[0.08] px-5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-white/[0.16]"
            >
              <FaFolderOpen className="text-xs" />
              {folder ? 'Use another folder' : 'Point at a folder'}
            </button>
          )}
        </div>
      </div>
      {note && <p className="mt-2 text-xs text-amber-300/80">{note}</p>}
      <p className="mt-2 text-xs text-amber-200/50">
        Everything else survived: the pairings, the subtitle tracks, the artwork and where you
        were up to. Nothing has been uploaded anywhere — this is all on this device.
      </p>
    </div>
  );
}
