/**
 * Poster art, captured from the video itself.
 *
 * A library of files has no artwork — just filenames — and a poster grid with
 * no posters looks broken. The frame is the honest source: it needs no API key,
 * no network call, tells nobody what you are watching, and works for material
 * no database has ever heard of, which is most of what ends up in a folder like
 * this.
 *
 * One rule matters more than the rest: **never make a Drive file download just
 * to draw a thumbnail.** `resolveUrl()` on an uncached Drive asset fetches the
 * whole film, so opening the library would quietly pull gigabytes. Capture is
 * therefore gated on `asset.ready`, which is always true locally and only true
 * for a Drive file already on disk.
 */

import { get, put, del, STORES } from './store.js';

/** Far enough in to be past logos and black, not so far it spoils anything. */
const SEEK_FRACTION = 0.2;
const MAX_WIDTH = 480;
const CAPTURE_TIMEOUT_MS = 12000;
/** Portrait card art, matching the 2:3 the card grid is built around. */
const POSTER_W = 400;
const POSTER_H = 600;

const urls = new Map();     // key -> object URL, so repeated renders reuse one
const inflight = new Map(); // key -> Promise, so a grid doesn't capture twice

/** Two shapes come out of one capture: a 2:3 card and a 16:9 backdrop. */
const posterKey = (key) => `${key}:poster`;

const toUrl = (key, blob) => {
  const existing = urls.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
};

/**
 * Art for this entry. `shape` picks which of the two cached renders you get:
 *
 *   'backdrop' — the frame as shot, 16:9, for the hero and the watch page
 *   'poster'   — 2:3, for the card grid
 *
 * Both come from one capture and one decode.
 */
export function artFor(entry, shape = 'poster') {
  const asset = entry?.video;
  if (!asset?.key) return Promise.resolve(null);
  const { key } = asset;
  const cacheKey = shape === 'poster' ? posterKey(key) : key;

  if (urls.has(cacheKey)) return Promise.resolve(urls.get(cacheKey));
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const job = (async () => {
    const cached = await get(STORES.posters, cacheKey);
    if (cached instanceof Blob) return toUrl(cacheKey, cached);

    // The gate: a Drive file that is not on disk would have to be downloaded.
    if (asset.ready === false) return null;

    try {
      const shots = await capture(await asset.resolveUrl());
      if (!shots) return null;
      // Store both while the decode is warm — the grid will ask for the other
      // shape a moment later and there is no sense decoding the film twice.
      if (shots.backdrop) await put(STORES.posters, key, shots.backdrop);
      if (shots.poster) await put(STORES.posters, posterKey(key), shots.poster);
      const blob = shape === 'poster' ? shots.poster : shots.backdrop;
      return blob ? toUrl(cacheKey, blob) : null;
    } catch {
      return null;   // an undecodable container is not an error worth showing
    }
  })();

  inflight.set(cacheKey, job);
  job.catch(() => {}).finally(() => inflight.delete(cacheKey));
  return job;
}

/** The 2:3 card render. */
export const posterFor = (entry) => artFor(entry, 'poster');
/** The 16:9 render, as the frame was shot. */
export const backdropFor = (entry) => artFor(entry, 'backdrop');

/**
 * Draw one frame of `url` to two JPEG blobs: the frame itself, and a 2:3
 * portrait version of it.
 *
 * The portrait one is not a crop. Cropping 16:9 down to 2:3 keeps about a
 * third of the width and throws away the rest, which decapitates roughly every
 * other frame. Instead the frame is laid over a blurred, scaled-up copy of
 * itself — the trick every media server uses when it has stills but no poster
 * art. The whole frame stays visible and the card still has the poster shape
 * the grid is built around.
 */
function capture(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);

    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    video.addEventListener('error', () => finish(null));

    video.addEventListener('loadeddata', () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      // A short clip has nothing 20% in worth seeing; take what there is.
      const target = duration > 5 ? Math.min(duration * SEEK_FRACTION, duration - 1) : 0;
      if (target > 0) video.currentTime = target;
      else draw();
    }, { once: true });

    video.addEventListener('seeked', () => draw(), { once: true });

    function draw() {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) { finish(null); return; }

        const scale = Math.min(1, MAX_WIDTH / w);
        const wide = document.createElement('canvas');
        wide.width = Math.round(w * scale);
        wide.height = Math.round(h * scale);
        wide.getContext('2d').drawImage(video, 0, 0, wide.width, wide.height);

        const tall = document.createElement('canvas');
        tall.width = POSTER_W;
        tall.height = POSTER_H;
        const g = tall.getContext('2d');

        // Backdrop: the frame blown up to cover, blurred hard.
        const coverScale = Math.max(POSTER_W / w, POSTER_H / h);
        const bw = w * coverScale * 1.25;
        const bh = h * coverScale * 1.25;
        g.filter = 'blur(28px) saturate(1.3) brightness(0.55)';
        g.drawImage(video, (POSTER_W - bw) / 2, (POSTER_H - bh) / 2, bw, bh);
        g.filter = 'none';

        // Foreground: the whole frame, centred, as wide as the card.
        const fh = Math.round((h / w) * POSTER_W);
        g.drawImage(video, 0, Math.round((POSTER_H - fh) / 2), POSTER_W, fh);

        let done = 0;
        const shots = {};
        const step = (name) => (blob) => {
          shots[name] = blob;
          done += 1;
          if (done === 2) finish(shots.backdrop ? shots : null);
        };
        wide.toBlob(step('backdrop'), 'image/jpeg', 0.78);
        tall.toBlob(step('poster'), 'image/jpeg', 0.8);
      } catch {
        finish(null);   // a tainted canvas, in principle; object URLs are same-origin
      }
    }

    video.src = url;
  });
}

export async function forgetPoster(key) {
  for (const k of [key, posterKey(key)]) {
    const url = urls.get(k);
    if (url) { URL.revokeObjectURL(url); urls.delete(k); }
    await del(STORES.posters, k);
  }
}
