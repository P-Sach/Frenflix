/**
 * Exercises the Drive cache without Drive.
 *
 * The risky parts of that path are not the Drive calls — they are the OPFS
 * write (a worker holding a sync access handle, writing at an offset), the
 * completion marker, the second-run hit, and whether what comes back out is a
 * file a <video> will actually play. All of that can be driven against a
 * same-origin URL: the worker sends an Authorization header the dev server
 * ignores, and everything downstream is identical.
 */
import {
  ensureCached, subscribe, evict, evictAll, listCached, cacheUsage, cacheSupported,
} from '../src/lib/drive/cache.js';

const log = document.getElementById('log');
const lines = [];
const say = (s) => { lines.push(s); log.textContent = lines.join('\n'); };

window.__cacheBench = {
  supported: cacheSupported,

  async run({ url, fileId, name, size }) {
    const progress = [];
    const stop = subscribe(fileId, (s) => progress.push({ ...s }));

    const t0 = performance.now();
    const file = await ensureCached({ id: fileId, name, size, mediaUrl: url, token: 'fake-token' });
    const took = performance.now() - t0;
    stop();

    return {
      took: Math.round(took),
      size: file.size,
      isFile: file instanceof File || file instanceof Blob,
      progressUpdates: progress.length,
      sawDownloading: progress.some((p) => p.status === 'downloading'),
      finalStatus: progress[progress.length - 1]?.status,
      monotonic: progress.every((p, i) => i === 0 || p.loaded >= progress[i - 1].loaded),
    };
  },

  /** Second call: should be near-instant and never touch the network. */
  async runCached(args) {
    const before = performance.now();
    const file = await ensureCached({
      id: args.fileId, name: args.name, size: args.size, mediaUrl: args.url, token: 'fake-token',
    });
    return { took: Math.round(performance.now() - before), size: file.size };
  },

  /** Does the cached copy actually play, and can it seek? */
  async playable({ fileId, name, size, url }) {
    const file = await ensureCached({ id: fileId, name, size, mediaUrl: url, token: 'fake-token' });
    const objectUrl = URL.createObjectURL(file);
    const v = document.getElementById('v');
    v.src = objectUrl;
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('the cached copy would not decode'));
      setTimeout(() => rej(new Error('metadata never arrived')), 15000);
    });
    const duration = v.duration;
    // A seek into the middle is the thing Drive itself cannot do.
    v.currentTime = duration * 0.7;
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 5000); });
    const landed = v.currentTime;
    URL.revokeObjectURL(objectUrl);
    return { duration, seekTarget: duration * 0.7, landed, seekWorked: Math.abs(landed - duration * 0.7) < 1 };
  },

  async failure({ fileId, url }) {
    try {
      await ensureCached({ id: fileId, name: 'missing.webm', size: 0, mediaUrl: url, token: 'x' });
      return { threw: false };
    } catch (err) {
      const left = await listCached();
      return { threw: true, message: err.message, leftBehind: left.some((f) => f.key.includes(fileId)) };
    }
  },

  async failureSized({ fileId, url, size }) {
    try {
      await ensureCached({ id: fileId, name: 'short.webm', size, mediaUrl: url, token: 'x' });
      return { threw: false };
    } catch (err) {
      const left = await listCached();
      return { threw: true, message: err.message, leftBehind: left.some((f) => f.key.includes(fileId)) };
    }
  },

  async inventory() {
    return { files: await listCached(), bytes: await cacheUsage() };
  },

  evict, evictAll,
};

say(`cache bench ready (OPFS ${cacheSupported ? 'available' : 'MISSING'})`);
window.__cacheReady = true;
