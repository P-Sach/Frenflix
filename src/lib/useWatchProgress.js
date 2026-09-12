import { useCallback, useEffect, useState } from 'react';
import { fractionOf, recentlyWatched, resumable } from './progress.js';

/**
 * Watch progress for the whole library, keyed by file.
 *
 * Read once on mount and refreshed when the window regains focus, which is
 * when it can have changed — the writer is the player in this same tab, and
 * returning to the library is a focus event away.
 */
export function useWatchProgress() {
  const [rows, setRows] = useState({});

  const refresh = useCallback(async () => {
    const list = await recentlyWatched();
    const map = {};
    for (const row of list) map[row.key] = row;
    setRows(map);
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  const forEntry = useCallback((entry) => {
    const row = entry?.video?.key ? rows[entry.video.key] : null;
    if (!row) return null;
    return { ...row, fraction: fractionOf(row), canResume: resumable(row) };
  }, [rows]);

  return { forEntry, refresh, count: Object.keys(rows).length };
}

export default useWatchProgress;
