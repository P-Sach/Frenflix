/**
 * Downloads one Drive file to the origin private file system.
 *
 * This runs in a worker for one specific reason: `createSyncAccessHandle` is
 * worker-only, and it is the only OPFS write path that writes *in place*. The
 * main-thread alternative, `createWritable`, is specified to be atomic, which
 * Chrome implements by writing to a swap file and renaming on close — for a
 * film that means needing twice its size free and a multi-gigabyte copy at the
 * end. A sync handle writes at an offset, so peak disk use is the file itself.
 *
 * The download is a single unranged GET, because Drive's CORS policy refuses a
 * `Range` header (see api.js). One consequence worth knowing: an interrupted
 * download cannot be resumed and starts again from zero.
 */

const CHUNK_REPORT_MS = 200;

/** In-flight downloads, so an abort has something to abort. */
const running = new Map();

async function driveDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('drive', { create: true });
}

/** A zero-byte neighbour written only after a successful flush. */
const doneName = (key) => `${key}.done`;

async function markDone(dir, key) {
  const handle = await dir.getFileHandle(doneName(key), { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  access.flush();
  access.close();
}

async function clearDone(dir, key) {
  try { await dir.removeEntry(doneName(key)); } catch { /* was not there */ }
}

async function download({ key, url, token, fileId, resourceKey, expectedSize }) {
  const controller = new AbortController();
  running.set(key, controller);

  const dir = await driveDir();
  await clearDone(dir, key);

  const fileHandle = await dir.getFileHandle(key, { create: true });
  let access = null;

  try {
    const headers = { Authorization: `Bearer ${token}` };
    // A link-shared file needs its resource key on the download too, not just
    // on the metadata lookup that found it.
    if (fileId && resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${fileId}/${resourceKey}`;

    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(res.status === 401
        ? 'Google rejected the token part-way through the download.'
        : `Drive refused the download (${res.status}).`);
    }
    if (!res.body) throw new Error('This browser cannot stream the download.');

    // A 200 is not proof of media. An expired session, a quota notice or a
    // consent interstitial all come back as an HTML page with a perfectly
    // cheerful status, and without this check that page gets written to disk,
    // marked complete, and served as the film every time afterwards.
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('text/html') || type.startsWith('application/json')) {
      throw new Error('Drive sent a web page instead of the file. Sign in again and retry.');
    }

    // Content-Length is the honest total when Drive sends one; the metadata
    // size is the fallback for the progress bar.
    const declared = Number(res.headers.get('content-length') || 0) || expectedSize || 0;

    access = await fileHandle.createSyncAccessHandle();
    access.truncate(0);

    const reader = res.body.getReader();
    let offset = 0;
    let lastReport = 0;

    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at: offset });
      offset += value.byteLength;
      const now = Date.now();
      if (now - lastReport > CHUNK_REPORT_MS) {
        lastReport = now;
        self.postMessage({ type: 'progress', key, loaded: offset, total: declared });
      }
    }

    access.flush();
    access.close();
    access = null;

    if (declared && offset < declared) {
      throw new Error('The download ended early. Check the connection and try again.');
    }
    // Drive told us how big this file is when it was listed. A copy that does
    // not match it is not the file, whatever the status code said.
    if (expectedSize && Math.abs(offset - expectedSize) > 1024) {
      throw new Error(`Expected ${expectedSize} bytes from Drive but received ${offset}.`);
    }

    await markDone(dir, key);
    self.postMessage({ type: 'done', key, size: offset });
  } catch (err) {
    try { access?.close(); } catch { /* already gone */ }
    // A partial file is worse than none: it would look cached next time.
    try { (await driveDir()).removeEntry(key); } catch { /* nothing to remove */ }
    self.postMessage({
      type: 'error',
      key,
      message: controller.signal.aborted ? 'Download cancelled.' : (err?.message || String(err)),
      aborted: controller.signal.aborted,
    });
  } finally {
    running.delete(key);
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg?.type === 'download') {
    download(msg).catch((err) => {
      self.postMessage({ type: 'error', key: msg.key, message: err?.message || String(err) });
    });
  } else if (msg?.type === 'abort') {
    running.get(msg.key)?.abort();
  }
};
