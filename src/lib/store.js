/**
 * A very small IndexedDB wrapper.
 *
 * Two things outlive the tab and are too big or too structured for
 * localStorage: where you got to in each title, and the frame captured for its
 * poster. Both are plain key-value, so this is deliberately the smallest thing
 * that works rather than a dependency.
 *
 * Everything here resolves rather than rejects on failure. Storage can be
 * unavailable for reasons that have nothing to do with this app — private
 * windows, blocked site data, a browser mid-upgrade — and none of them are a
 * reason for a video player to stop playing video.
 */

const DB_NAME = 'frenflix';
const DB_VERSION = 2;
/**
 * `library` holds one record: the whole library graph, plus the
 * `FileSystemFileHandle`s that let the files themselves be reopened in a later
 * session. Handles are structured-cloneable, which is the entire reason this
 * is IndexedDB and not localStorage — a handle cannot survive being turned
 * into a string. See lib/persist.js.
 */
export const STORES = { progress: 'progress', posters: 'posters', library: 'library' };

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let request;
      try {
        const t = db.transaction(store, mode);
        request = fn(t.objectStore(store));
        t.onabort = () => resolve(null);
        t.onerror = () => resolve(null);
      } catch { resolve(null); return; }
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  }).catch(() => null);
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const put = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());

/** Every [key, value] pair in a store. */
export async function entries(store) {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const out = [];
    let cursorReq;
    try {
      const t = db.transaction(store, 'readonly');
      cursorReq = t.objectStore(store).openCursor();
      t.onerror = () => resolve(out);
    } catch { resolve(out); return; }
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) { resolve(out); return; }
      out.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    cursorReq.onerror = () => resolve(out);
  });
}
