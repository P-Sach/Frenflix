/**
 * Where you got to in each title.
 *
 * Keyed on the *file*, not on the library entry, because a library entry only
 * lives as long as the tab. Drop the same file in tomorrow and it is a new
 * entry with a new id — but the same bytes, so it should resume. Hence the
 * fingerprint in `sources.js`: Drive files key on their Drive id, local files
 * on name + size + last-modified, which is stable across re-adding and does
 * not require reading a byte of a multi-gigabyte file.
 */

import { get, put, del, clear, entries, STORES } from './store.js';

/**
 * The two thresholds scale with length, because fixed ones are wrong at both
 * extremes. "Within 60 seconds of the end counts as finished" is sensible for a
 * feature and absurd for a 70-second clip, where it marks everything past ten
 * seconds as watched — which is exactly how this failed the first time.
 */
const startedAt = (duration) => (duration ? Math.min(30, duration * 0.02) : 30);
const finishedWithin = (duration) => (duration ? Math.min(60, duration * 0.05) : 60);

export async function loadProgress(key) {
  if (!key) return null;
  return get(STORES.progress, key);
}

/**
 * @param {string} key
 * @param {{position:number, duration:number, title?:string}} data
 */
export async function saveProgress(key, { position, duration, title = '' }) {
  if (!key || !Number.isFinite(position) || position < 1) return;
  await put(STORES.progress, key, {
    position,
    duration: Number.isFinite(duration) ? duration : 0,
    title,
    updatedAt: Date.now(),
  });
}

export const forgetProgress = (key) => del(STORES.progress, key);
export const forgetAllProgress = () => clear(STORES.progress);

/** Everything watched, most recent first — the "continue watching" row. */
export async function recentlyWatched() {
  const rows = await entries(STORES.progress);
  return rows
    .map(([key, value]) => ({ key, ...value }))
    .filter((r) => resumable(r))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Is there a meaningful position to offer to resume from? */
export function resumable(row) {
  if (!row || !Number.isFinite(row.position)) return false;
  if (row.position < startedAt(row.duration)) return false;
  if (row.duration && row.position > row.duration - finishedWithin(row.duration)) return false;
  return true;
}

/** 0..1 for a progress bar. Returns 0 when the duration was never recorded. */
export function fractionOf(row) {
  if (!row?.duration) return 0;
  return Math.max(0, Math.min(1, row.position / row.duration));
}
