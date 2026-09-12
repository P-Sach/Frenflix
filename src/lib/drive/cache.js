/**
 * A local copy of a Drive file, kept in the origin private file system.
 *
 * Drive will not serve ranged reads to a browser (api.js explains why), and a
 * media element does nothing but ranged reads. The way out is to stop asking
 * Drive to behave like a media server: pull the file down once with a single
 * plain GET, keep it on disk, and hand the player an ordinary local file. The
 * player then behaves exactly as it does for a dropped file — instant seeking,
 * no network during playback, and the whole sync engine untouched.
 *
 * The copy survives a reload, so a title watched yesterday starts immediately
 * today. That also makes Drive titles the only ones that outlive a refresh:
 * a dropped local file leaves nothing behind but an object URL, which dies
 * with the page.
 */

const listeners = new Map();   // key -> Set<fn>
const states = new Map();      // key -> {status, loaded, total, error}
const inflight = new Map();    // key -> Promise<File>
let worker = null;

const supported = typeof navigator !== 'undefined'
  && Boolean(navigator.storage?.getDirectory);

export const cacheSupported = supported;

/** OPFS names have to be filesystem-safe; a Drive id already is, but be sure. */
const keyFor = (fileId) => `f_${String(fileId).replace(/[^A-Za-z0-9_-]/g, '')}`;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./cache.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    const state = states.get(msg.key);
    if (!state) return;
    if (msg.type === 'progress') {
      update(msg.key, { status: 'downloading', loaded: msg.loaded, total: msg.total || state.total });
    } else if (msg.type === 'done') {
      update(msg.key, { status: 'ready', loaded: msg.size, total: msg.size, error: null });
      state.resolve?.(msg.size);
    } else if (msg.type === 'error') {
      update(msg.key, { status: 'error', error: msg.message });
      state.reject?.(new Error(msg.message));
    }
  };
  return worker;
}

function update(key, patch) {
  const next = { ...(states.get(key) || {}), ...patch };
  states.set(key, next);
  const set = listeners.get(key);
  if (set) set.forEach((fn) => fn(publicState(next)));
}

const publicState = (s) => ({
  status: s?.status || 'remote',
  loaded: s?.loaded || 0,
  total: s?.total || 0,
  error: s?.error || null,
  progress: s?.total ? Math.min(1, (s.loaded || 0) / s.total) : 0,
});

export function subscribe(fileId, fn) {
  const key = keyFor(fileId);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  fn(publicState(states.get(key)));
  return () => listeners.get(key)?.delete(fn);
}

export function stateOf(fileId) {
  return publicState(states.get(keyFor(fileId)));
}

async function driveDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('drive', { create: true });
}

/** A finished download leaves a zero-byte marker beside the data. */
async function cachedFile(key) {
  try {
    const dir = await driveDir();
    await dir.getFileHandle(`${key}.done`);       // throws if the marker is absent
    const handle = await dir.getFileHandle(key);
    return await handle.getFile();
  } catch {
    return null;
  }
}

/**
 * Is there room? Asking first turns "the download died at 90%" into a sentence
 * somebody can act on before they wait twenty minutes for it.
 */
export async function checkRoom(bytes) {
  if (!navigator.storage?.estimate || !bytes) return { ok: true };
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  const free = quota - usage;
  // A little headroom: the browser will start evicting well before absolute zero.
  if (free && bytes > free * 0.9) {
    return {
      ok: false,
      free,
      message: `This file needs ${(bytes / 1e9).toFixed(1)} GB and the browser will only `
        + `allow about ${(free / 1e9).toFixed(1)} GB more storage for this site.`,
    };
  }
  return { ok: true, free };
}

/**
 * Ensure a local copy exists and return it.
 *
 * @param {{id: string, name: string, size: number, mediaUrl: string, token: string,
 *   resourceKey?: string}} meta
 * @returns {Promise<File>}
 */
export function ensureCached(meta) {
  const key = keyFor(meta.id);
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    if (!supported) {
      throw new Error('This browser has no origin private file system, so Drive files cannot be cached.');
    }
    const already = await cachedFile(key);
    if (already) {
      update(key, { status: 'ready', loaded: already.size, total: already.size, error: null });
      return already;
    }

    const room = await checkRoom(meta.size);
    if (!room.ok) {
      update(key, { status: 'error', error: room.message });
      throw new Error(room.message);
    }

    update(key, { status: 'downloading', loaded: 0, total: meta.size || 0, error: null });

    await new Promise((resolve, reject) => {
      const state = states.get(key);
      state.resolve = resolve;
      state.reject = reject;
      getWorker().postMessage({
        type: 'download',
        key,
        url: meta.mediaUrl,
        token: meta.token,
        fileId: meta.id,
        resourceKey: meta.resourceKey || '',
        expectedSize: meta.size || 0,
      });
    });

    const file = await cachedFile(key);
    if (!file) throw new Error('The download finished but the local copy is missing.');
    // Returned as-is rather than re-wrapped in a File with the original name.
    // `new File([file], name)` is a copy the spec permits the browser to
    // materialise, which on a feature film is the kind of thing that ends a
    // session. Nothing needs the name: the pairing matcher reads it off the
    // Drive metadata on the asset, never off the handle.
    return file;
  })();

  inflight.set(key, job);
  job.catch(() => {}).finally(() => inflight.delete(key));
  return job;
}

export function cancel(fileId) {
  const key = keyFor(fileId);
  getWorker().postMessage({ type: 'abort', key });
}

/** Everything held locally, for the storage panel. */
export async function listCached() {
  if (!supported) return [];
  const dir = await driveDir();
  const done = new Set();
  const sizes = new Map();
  // eslint-disable-next-line no-restricted-syntax
  for await (const [name, handle] of dir.entries()) {
    if (name.endsWith('.done')) done.add(name.slice(0, -5));
    else if (handle.kind === 'file') sizes.set(name, handle);
  }
  const out = [];
  for (const key of done) {
    const handle = sizes.get(key);
    if (!handle) continue;
    // eslint-disable-next-line no-await-in-loop
    const file = await handle.getFile();
    out.push({ key, size: file.size });
  }
  return out;
}

export async function evict(fileId) {
  const key = keyFor(fileId);
  const dir = await driveDir();
  try { await dir.removeEntry(`${key}.done`); } catch { /* not there */ }
  try { await dir.removeEntry(key); } catch { /* not there */ }
  states.delete(key);
}

export async function evictAll() {
  if (!supported) return;
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('drive', { recursive: true }); } catch { /* nothing cached */ }
  states.clear();
}

export async function cacheUsage() {
  const files = await listCached();
  return files.reduce((sum, f) => sum + f.size, 0);
}
