/**
 * Media source layer.
 *
 * Everything above this file deals in "assets" — an id, a name, a kind, and a
 * way to get a playable URL. Nothing above knows whether the bytes come from
 * the user's disk or from Google Drive, which is the entire point: adding
 * Drive changed this file and the UI that picks the files, and touched neither
 * the player, the pairing, the subtitles nor the sync engine.
 */

import { parseSubtitles, readSubtitleFile } from './subtitles.js';
import { fileFromHandle, readPermission, requestRead } from './handles.js';
import { ensureCached, subscribe as subscribeCache, stateOf, cancel as cancelCache } from './drive/cache.js';
import { mediaUrl, fetchSmallFile } from './drive/api.js';
import { ensureToken } from './drive/auth.js';

let counter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(counter += 1)}`;

/** Assets we've handed out object URLs for, so we can revoke them later. */
const objectUrls = new Map();

/**
 * @typedef {Object} MediaAsset
 * @property {string} id
 * @property {string} name        original filename
 * @property {'video'|'audio'|'subtitle'} kind
 * @property {'local'|'drive'} origin
 * @property {number} size        bytes, 0 if unknown
 * @property {string} key   stable across sessions; what watch progress is filed under
 * @property {() => Promise<string>} resolveUrl
 * @property {() => void} release
 */

/**
 * An identity for a file that survives the tab.
 *
 * `id` is per-session and useless for this: re-add the same film tomorrow and
 * it gets a new one. A Drive file has a real identity already. A local file
 * does not, so name + size + last-modified stands in — stable across
 * re-adding, and it costs nothing, where hashing the contents of a 4GB film
 * would cost minutes.
 */
export const localKey = (file) => `local:${file.name}|${file.size}|${file.lastModified || 0}`;
export const driveKey = (fileId) => `drive:${fileId}`;

/**
 * A file on this machine.
 *
 * Object URLs are the whole reason local playback is instant at any size: the
 * browser reads straight off disk, so seeking a 40GB file is as fast as seeking
 * a 40MB one and not a single byte crosses the network.
 *
 * The `File` may be absent. That is what a title restored from a previous
 * session looks like: its name, size, pairings, poster art and watch position
 * all came back from IndexedDB, but the bytes need reopening — from a stored
 * `FileSystemFileHandle` if there is one, otherwise by the file being dropped
 * again. `availability` is the one thing the UI reads to know which it is.
 */
function makeFileAsset({
  key, name, kind, size = 0, file = null, handle = null,
}) {
  const id = nextId('local');
  let current = file;
  const asset = {
    id,
    key,
    name,
    kind,
    origin: 'local',
    size,
    handle,
    get file() { return current; },
    get ready() { return Boolean(current); },
    /**
     * 'ready'   — the bytes are here
     * 'locked'  — there is a stored handle, and the browser wants a click
     * 'missing' — no handle; this file has to be dropped again
     */
    get availability() {
      if (current) return 'ready';
      return asset.handle ? 'locked' : 'missing';
    },

    /** Promote to usable: the same file dropped again, or a granted handle. */
    attach(nextFile, nextHandle = null) {
      if (!nextFile) return asset;
      asset.release();                 // the old URL points at the old File
      current = nextFile;
      asset.size = nextFile.size ?? asset.size;
      if (nextHandle) asset.handle = nextHandle;
      return asset;
    },

    /**
     * Re-acquire the file from the stored handle.
     *
     * `ask` may only be true inside a user gesture, and only for one handle
     * per gesture — see handles.js on why a directory handle is worth so much
     * more than a pile of file handles.
     *
     * @returns {Promise<boolean>} whether the bytes are available now
     */
    async reopen({ ask = false } = {}) {
      if (current) return true;
      if (!asset.handle) return false;
      let state = await readPermission(asset.handle);
      if (state !== 'granted' && ask) state = await requestRead(asset.handle);
      if (state !== 'granted') return false;
      const got = await fileFromHandle(asset.handle);
      if (!got) return false;          // moved, renamed or deleted since
      current = got;
      asset.size = got.size ?? asset.size;
      return true;
    },

    async resolveUrl() {
      if (!current && !(await asset.reopen())) {
        const err = new Error(asset.handle
          ? `${name} needs permission again before it can play.`
          : `${name} is not held by this page any more — drop the file again.`);
        err.name = 'AssetUnavailable';
        err.availability = asset.availability;
        throw err;
      }
      let url = objectUrls.get(id);
      if (!url) {
        url = URL.createObjectURL(current);
        objectUrls.set(id, url);
      }
      return url;
    },

    release() {
      const url = objectUrls.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.delete(id);
      }
    },
  };
  return asset;
}

/**
 * Wrap a File from a drop or a file input.
 *
 * @param {File} file
 * @param {'video'|'audio'|'subtitle'} kind
 * @param {FileSystemFileHandle|null} handle when the browser offered one
 * @returns {MediaAsset}
 */
export function createLocalAsset(file, kind, handle = null) {
  return makeFileAsset({
    key: localKey(file),
    name: file.name,
    kind,
    size: file.size ?? 0,
    file,
    handle,
  });
}

/**
 * A title remembered from a previous session whose bytes are not here yet.
 * @param {{key:string,name:string,kind:string,size?:number,handle?:object}} meta
 */
export function createRestoredAsset(meta) {
  return makeFileAsset({ ...meta, file: null });
}

/**
 * A subtitle file. Same asset shape, but what callers want is the parsed cue
 * list rather than a URL — and parsing is deferred until a track is actually
 * switched on, since a folder can carry a dozen of them.
 *
 * @param {File} file
 * @returns {MediaAsset & {loadCues: () => Promise<Array>}}
 */
export function createSubtitleAsset(file, handle = null) {
  const asset = createLocalAsset(file, 'subtitle', handle);
  let cues = null;
  asset.loadCues = async () => {
    if (cues) return cues;
    // The text is kept on the asset so it can be written into the saved
    // library. A subtitle file is kilobytes, so storing the text itself means
    // subtitle tracks come back in a later session with no handle and no
    // permission at all — the right trade for something this small.
    asset.text = await readSubtitleFile(asset.file);
    cues = parseSubtitles(asset.text);
    return cues;
  };
  return asset;
}

/**
 * A subtitle track restored from the saved library. Its text was stored, so
 * unlike video and audio it needs nothing reopened and no permission.
 * @param {{key:string,name:string,text:string}} meta
 */
export function createRestoredSubtitleAsset({ key, name, text = '' }) {
  const id = nextId('localsub');
  let cues = null;
  return {
    id,
    key,
    name,
    kind: 'subtitle',
    origin: 'local',
    size: text.length,
    text,
    ready: true,
    availability: 'ready',
    async loadCues() {
      if (!cues) cues = parseSubtitles(text);
      return cues;
    },
    async resolveUrl() { throw new Error('Subtitles are read as text, not as a URL.'); },
    release() {},
  };
}

/**
 * A file in Google Drive.
 *
 * `resolveUrl` is where the difference lives, and it is a big one: it may have
 * to fetch several gigabytes before it can answer. Drive refuses ranged reads
 * to a browser, so there is no way to stream it (see `drive/api.js`); the file
 * is copied to the origin private file system once and then behaves exactly
 * like a dropped file, seeking included. The copy outlives the tab, so this
 * only happens the first time.
 *
 * Callers that care about the wait — the watch page — use `subscribe` for
 * progress. Callers that do not can just await the URL.
 *
 * @param {{id: string, name: string, size?: number, mimeType?: string,
 *   resourceKey?: string}} meta
 * @param {'video'|'audio'} kind
 * @returns {MediaAsset}
 */
export function createDriveAsset(meta, kind) {
  const id = nextId('drive');
  return {
    id,
    key: driveKey(meta.id),
    name: meta.name,
    kind,
    origin: 'drive',
    size: meta.size ?? 0,
    fileId: meta.id,
    mimeType: meta.mimeType || '',
    resourceKey: meta.resourceKey || '',
    get cacheState() { return stateOf(meta.id); },
    get ready() { return stateOf(meta.id).status === 'ready'; },
    subscribe(fn) { return subscribeCache(meta.id, fn); },
    cancel() { cancelCache(meta.id); },
    async resolveUrl() {
      const existing = objectUrls.get(id);
      if (existing) return existing;
      const token = await ensureToken();
      const file = await ensureCached({
        id: meta.id,
        name: meta.name,
        size: meta.size ?? 0,
        mediaUrl: mediaUrl(meta.id),
        resourceKey: meta.resourceKey || '',
        token,
      });
      // A second caller may have won the race while we were downloading.
      const won = objectUrls.get(id);
      if (won) return won;
      const url = URL.createObjectURL(file);
      objectUrls.set(id, url);
      return url;
    },
    release() {
      const url = objectUrls.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.delete(id);
      }
      // The cached copy is deliberately left on disk — that is the point of it.
    },
  };
}

/**
 * A subtitle file in Drive. Measured in kilobytes, so it is fetched straight
 * into memory when a track is switched on rather than going near the cache.
 */
export function createDriveSubtitleAsset(meta) {
  const id = nextId('drivesub');
  let cues = null;
  return {
    id,
    key: driveKey(meta.id),
    name: meta.name,
    kind: 'subtitle',
    origin: 'drive',
    size: meta.size ?? 0,
    fileId: meta.id,
    resourceKey: meta.resourceKey || '',
    ready: true,
    async loadCues() {
      if (cues) return cues;
      // A Blob has arrayBuffer(), which is all the decoder wants — so the
      // strict-UTF-8-then-Windows-1252 handling applies to Drive files too.
      cues = parseSubtitles(await readSubtitleFile(
        await fetchSmallFile(meta.id, meta.resourceKey || ''),
      ));
      return cues;
    },
    async resolveUrl() { throw new Error('Subtitles are read as text, not as a URL.'); },
    release() {},
  };
}

export function releaseAll(assets = []) {
  assets.forEach((a) => a.release?.());
}

export function formatBytes(bytes = 0) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
