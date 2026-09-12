/**
 * Getting a file back after the tab has closed.
 *
 * A `File` from a drop or a file input is a one-session thing: the object URL
 * dies with the page and nothing about the File can be written down and used
 * again. That is why the library used to empty on reload, and it is not a
 * storage problem — the browser deliberately does not let a page keep hold of
 * a path.
 *
 * What it does allow is a `FileSystemFileHandle`: a capability, granted by the
 * user, that IS structured-cloneable and so can be stored in IndexedDB and
 * used in a later session. Two ways to obtain one:
 *
 *   - `showOpenFilePicker` / `showDirectoryPicker` — an explicit choice
 *   - `DataTransferItem.getAsFileSystemHandle()` — from an ordinary drag and
 *     drop, which is the nice part: dropping files keeps working exactly as it
 *     did and quietly yields handles as well
 *
 * Permission is not forever. Within a session a granted handle stays granted;
 * after a browser restart `queryPermission` usually reports `prompt` again and
 * one click re-grants it. A *directory* handle is worth far more than a pile of
 * file handles for that reason: one grant covers everything inside it, where
 * twenty file handles mean twenty prompts — the browser spends the click's user
 * activation on the first one.
 *
 * None of this exists in Firefox or Safari, where `handlesSupported` is false
 * and the library falls back to remembering everything *about* each title and
 * re-attaching the file when it is dropped again.
 */

const MEDIA_ACCEPT = [
  {
    description: 'Video, audio and subtitles',
    accept: {
      'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ogv'],
      'audio/*': ['.m4a', '.mp3', '.aac', '.opus', '.ogg', '.flac', '.wav', '.ac3', '.eac3', '.dts'],
      'text/plain': ['.srt', '.vtt', '.ass', '.ssa', '.sub', '.sbv'],
    },
  },
];

export const handlesSupported = typeof window !== 'undefined'
  && typeof window.showOpenFilePicker === 'function';

export const directoryPickerSupported = typeof window !== 'undefined'
  && typeof window.showDirectoryPicker === 'function';

/** Does a drop event carry handles, or only Files? */
export const dropHandlesSupported = typeof DataTransferItem !== 'undefined'
  && typeof DataTransferItem.prototype.getAsFileSystemHandle === 'function';

/** 'granted' | 'prompt' | 'denied' — and 'granted' for anything without a handle. */
export async function readPermission(handle) {
  if (!handle?.queryPermission) return 'granted';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/**
 * Ask for read access. Must be called from a user gesture.
 *
 * The browser spends that gesture's activation on the first prompt it shows,
 * so asking for several handles in one click only ever gets the first. The
 * caller is expected to know that and to prefer a directory handle.
 */
export async function requestRead(handle) {
  if (!handle?.requestPermission) return 'granted';
  try {
    return await handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** The File behind a handle, or null if permission is not (or no longer) there. */
export async function fileFromHandle(handle) {
  if (!handle?.getFile) return null;
  try {
    if (await readPermission(handle) !== 'granted') return null;
    return await handle.getFile();
  } catch {
    // The file was moved, renamed or deleted since the handle was stored.
    return null;
  }
}

/** Every file directly or indirectly inside a directory handle. */
async function walk(dirHandle, out = [], depth = 0) {
  if (depth > 4) return out;                    // a media folder is not a filesystem
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        try { out.push({ file: await entry.getFile(), handle: entry }); } catch { /* skip */ }
      } else if (entry.kind === 'directory') {
        await walk(entry, out, depth + 1);
      }
      if (out.length > 2000) break;
    }
  } catch { /* permission withdrawn mid-walk */ }
  return out;
}

export { walk as filesInDirectory };

/**
 * Read a drop as `{file, handle}` pairs, with handles wherever the browser
 * offers them. Folders are walked, so dropping a season folder works.
 *
 * `getAsFileSystemHandle` has to be called before any await, because the
 * DataTransferItemList is emptied as soon as the event handler yields — which
 * is the usual reason drag-and-drop code mysteriously sees nothing.
 */
export async function readDrop(dataTransfer) {
  const plain = Array.from(dataTransfer?.files || []);
  if (!dropHandlesSupported || !dataTransfer?.items?.length) {
    return { picks: plain.map((file) => ({ file, handle: null })), directory: null };
  }

  const pending = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    try { pending.push(item.getAsFileSystemHandle()); } catch { /* fall back below */ }
  }

  const handles = (await Promise.all(pending.map((p) => p.catch(() => null)))).filter(Boolean);
  if (handles.length === 0) {
    return { picks: plain.map((file) => ({ file, handle: null })), directory: null };
  }

  const picks = [];
  let directory = null;
  for (const handle of handles) {
    if (handle.kind === 'directory') {
      directory = directory || handle;
      picks.push(...await walk(handle));
    } else {
      try { picks.push({ file: await handle.getFile(), handle }); } catch { /* skip */ }
    }
  }
  // Belt and braces: if the handle path produced nothing usable, the plain
  // files are still right there.
  if (picks.length === 0) {
    return { picks: plain.map((file) => ({ file, handle: null })), directory };
  }
  return { picks, directory };
}

/** The explicit picker. Returns [] when the user cancels. */
export async function pickFiles() {
  if (!handlesSupported) return [];
  try {
    const handles = await window.showOpenFilePicker({ multiple: true, types: MEDIA_ACCEPT });
    const out = [];
    for (const handle of handles) {
      try { out.push({ file: await handle.getFile(), handle }); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];                                  // cancelled
  }
}

/**
 * Pick a folder — the one worth preferring.
 *
 * One handle, one permission, everything inside it, and it keeps working for
 * files added to that folder later. This is how a media library actually
 * wants to be pointed at its media.
 */
export async function pickFolder() {
  if (!directoryPickerSupported) return null;
  try {
    const dir = await window.showDirectoryPicker({ id: 'frenflix-library', mode: 'read' });
    return { directory: dir, picks: await walk(dir) };
  } catch {
    return null;                                // cancelled
  }
}
