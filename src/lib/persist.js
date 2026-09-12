/**
 * The library, written down.
 *
 * Everything in FrenFlix is client-side by design, and that used to mean the
 * library evaporated on reload: the videos, the dub pairings, the subtitle
 * links and the queue all lived in a reducer, and a `File` cannot be written
 * down anyway. Watch positions and poster art already survived (`progress.js`,
 * `thumbnails.js`) because both are keyed on a *file fingerprint* rather than
 * on a session id — and that same fingerprint is what makes the rest of it
 * storable.
 *
 * So what goes in the record is the graph, expressed in fingerprints:
 *
 *   videos/audios     name, size, origin, and a `FileSystemFileHandle` where
 *                     the browser gave us one (handles are
 *                     structured-cloneable, which is the whole reason this is
 *                     IndexedDB — a handle cannot survive being stringified)
 *   subtitles         the text itself; they are kilobytes, and storing the
 *                     text means they come back with no permission at all
 *   links/subLinks    which dub and which subtitle tracks belong to which
 *                     title, by fingerprint
 *   queue             by fingerprint
 *   directory         one directory handle, if the library was pointed at a
 *                     folder — worth more than every file handle combined,
 *                     because one grant covers everything inside it
 *
 * Drive titles need no handle: their bytes are already in the origin private
 * file system (`drive/cache.js`), so they come back ready to play with nothing
 * asked of anyone.
 *
 * Nothing here rejects. Storage can be unavailable for reasons that have
 * nothing to do with this app, and none of them are a reason for a video
 * player to stop working — it just forgets, as it always used to.
 */

import { get, put, del, STORES } from './store.js';

const RECORD = 'snapshot';
/** Bumped when the shape below changes incompatibly. Older records are dropped. */
const FORMAT = 1;
/** Saves are coalesced: adding forty files is one write, not forty. */
const SAVE_DEBOUNCE_MS = 400;

let timer = null;
let pending = null;

const assetRecord = (a) => (a.origin === 'drive'
  ? {
    key: a.key,
    origin: 'drive',
    name: a.name,
    kind: a.kind,
    size: a.size || 0,
    fileId: a.fileId,
    resourceKey: a.resourceKey || '',
    mimeType: a.mimeType || '',
  }
  : {
    key: a.key,
    origin: 'local',
    name: a.name,
    kind: a.kind,
    size: a.size || 0,
    // Undefined rather than null: IndexedDB stores the handle object as-is,
    // and there is no point writing a key that means nothing.
    handle: a.handle || undefined,
  });

const subtitleRecord = (a) => (a.origin === 'drive'
  ? {
    key: a.key,
    origin: 'drive',
    name: a.name,
    fileId: a.fileId,
    resourceKey: a.resourceKey || '',
  }
  : {
    key: a.key,
    origin: 'local',
    name: a.name,
    // Present once the track has been switched on at least once. A track that
    // was never opened has no text to store, so it comes back as a name and is
    // re-read from the file when there is one.
    text: typeof a.text === 'string' ? a.text : undefined,
    handle: a.handle || undefined,
  });

/**
 * Translate the reducer's id-keyed graph into a fingerprint-keyed one.
 *
 * Session ids are regenerated every time the page loads, so storing them would
 * store nothing. Fingerprints are stable across sessions and across the same
 * file being added again, which is exactly the property needed.
 */
export function snapshotOf(state, directory = null) {
  const videoKey = new Map(state.videos.map((v) => [v.id, v.key]));
  const audioKey = new Map(state.audios.map((a) => [a.id, a.key]));
  const subKey = new Map(state.subtitles.map((x) => [x.id, x.key]));

  const links = {};
  for (const [vid, list] of Object.entries(state.links)) {
    const key = videoKey.get(vid);
    if (!key) continue;
    const tracks = list
      .map((t) => (audioKey.has(t.audioId)
        ? { audioKey: audioKey.get(t.audioId), confidence: t.confidence, reason: t.reason }
        : null))
      .filter(Boolean);
    if (tracks.length) links[key] = tracks;
  }

  const subLinks = {};
  for (const [vid, ids] of Object.entries(state.subLinks)) {
    const key = videoKey.get(vid);
    if (!key) continue;
    const keys = ids.map((id) => subKey.get(id)).filter(Boolean);
    if (keys.length) subLinks[key] = keys;
  }

  return {
    format: FORMAT,
    savedAt: Date.now(),
    videos: state.videos.map(assetRecord),
    audios: state.audios.map(assetRecord),
    subtitles: state.subtitles.map(subtitleRecord),
    links,
    subLinks,
    queue: state.queue.map((id) => videoKey.get(id)).filter(Boolean),
    directory: directory || undefined,
  };
}

/** Write now. Returns whether it was stored. */
export async function saveNow(state, directory = null) {
  try {
    const snap = snapshotOf(state, directory);
    if (snap.videos.length === 0 && snap.audios.length === 0 && snap.subtitles.length === 0) {
      await del(STORES.library, RECORD);
      return true;
    }
    await put(STORES.library, RECORD, snap);
    return true;
  } catch {
    // A handle that will not clone, quota, a private window — forget it and
    // carry on. The session in front of the user still works.
    return false;
  }
}

/**
 * Write soon. Called on every library change, so it coalesces: dropping a
 * folder of forty files is one record, not forty.
 */
export function save(state, directory = null) {
  pending = { state, directory };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const next = pending;
    pending = null;
    if (next) saveNow(next.state, next.directory);
  }, SAVE_DEBOUNCE_MS);
}

/** Flush a pending save immediately — used on the way out of the page. */
export function flush() {
  if (!timer || !pending) return Promise.resolve(false);
  clearTimeout(timer);
  timer = null;
  const next = pending;
  pending = null;
  return saveNow(next.state, next.directory);
}

export async function load() {
  const snap = await get(STORES.library, RECORD);
  if (!snap || snap.format !== FORMAT) return null;
  if (!Array.isArray(snap.videos)) return null;
  return snap;
}

export async function forget() {
  if (timer) { clearTimeout(timer); timer = null; }
  pending = null;
  await del(STORES.library, RECORD);
}
