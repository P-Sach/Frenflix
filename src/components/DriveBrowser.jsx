import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFile, listFiles } from '../lib/drive/api';
import { parseDriveRefs } from '../lib/drive/links';
import { signIn, signOut, subscribe as subscribeAuth } from '../lib/drive/auth';
import { SETUP_STEPS } from '../lib/drive/config';
import { classify } from '../lib/pairing';
import { formatBytes } from '../lib/sources';

/**
 * Browse Drive and pick files.
 *
 * A hand-rolled browser rather than Google's Picker widget, because the Picker
 * needs a second credential (an API key) and its own script, and because a
 * chooser that matches the rest of the app is worth more here than one that
 * matches Drive. Selection is by checkbox and spans folders, so the video, the
 * dub track and the subtitles can come from three different places in one go.
 *
 * Links are the other way in, and often the only one: a file someone shared
 * with you is not in your Drive to browse to. Paste one link or twenty — the
 * usual case is a message containing a video link, a dub track link and a
 * subtitle link, and the whole message can go in at once.
 */

const isMedia = (f) => {
  if (f.isFolder) return false;
  if (f.isNative) return false;
  const kind = classify(f.name);
  if (kind) return true;
  return f.mimeType.startsWith('video/') || f.mimeType.startsWith('audio/');
};

const kindOf = (f) => classify(f.name)
  || (f.mimeType.startsWith('video/') ? 'video' : f.mimeType.startsWith('audio/') ? 'audio' : null);

const KIND_TAG = {
  video: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  audio: 'text-violet-300 border-violet-500/40 bg-violet-500/10',
  subtitle: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
};

export default function DriveBrowser({ open, onClose, onAdd }) {
  const [auth, setAuth] = useState({ configured: false, signedIn: false, account: null });
  const [path, setPath] = useState([{ id: 'root', name: 'My Drive' }]);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [pageToken, setPageToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(new Map());
  const [linkText, setLinkText] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkReport, setLinkReport] = useState(null);
  const searchTimer = useRef(null);

  useEffect(() => subscribeAuth(setAuth), []);

  const folderId = path[path.length - 1].id;

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFiles({
        folderId: opts.folderId ?? folderId,
        resourceKey: opts.resourceKey ?? path[path.length - 1].resourceKey ?? '',
        search: opts.search ?? search,
        pageToken: opts.pageToken || '',
      });
      setPageToken(res.nextPageToken);
      const visible = res.files.filter((f) => f.isFolder || isMedia(f));
      setItems((prev) => (opts.pageToken ? [...prev, ...visible] : visible));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [folderId, search, path]);

  useEffect(() => {
    if (!open || !auth.signedIn) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, auth.signedIn, folderId]);

  // Debounced search, so every keystroke isn't a Drive query.
  useEffect(() => {
    if (!open || !auth.signedIn) return undefined;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load({ pageToken: '' }), 350);
    return () => clearTimeout(searchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  /**
   * Resolve pasted links into selected files.
   *
   * Each reference is looked up individually and reported on individually: one
   * dead link out of four should add the other three and say which one failed,
   * not refuse the lot. A folder link navigates there instead, since that is
   * plainly what it means.
   */
  const resolveLinks = useCallback(async () => {
    const { refs, bad } = parseDriveRefs(linkText);
    if (refs.length === 0 && bad.length === 0) return;

    setLinkBusy(true);
    setLinkReport(null);
    const added = [];
    const failed = bad.map((t) => ({ ref: t, message: 'Not a Drive link or file id.' }));
    let navigated = null;

    for (const ref of refs) {
      // Folder links are looked up rather than navigated to blind: the lookup
      // is what supplies the folder's real name for the breadcrumb, and it
      // fails here — with a reason — instead of opening a folder that then
      // turns out not to be readable.
      if (ref.kind === 'native') {
        failed.push({
          ref: ref.id,
          message: 'That is a Google Docs/Sheets/Slides file — there is no media file behind it.',
        });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const file = await getFile(ref.id, ref.resourceKey);
        if (file.isFolder) { navigated = { id: file.id, resourceKey: file.resourceKey, name: file.name }; continue; }
        if (file.isNative) {
          failed.push({ ref: file.name, message: 'A Google-format file has no media to download.' });
          continue;
        }
        if (!kindOf(file) && !isMedia(file)) {
          failed.push({ ref: file.name, message: `Not video, audio or subtitles (${file.mimeType || 'unknown type'}).` });
          continue;
        }
        added.push(file);
      } catch (err) {
        failed.push({ ref: ref.id, message: err.message });
      }
    }

    if (added.length) {
      setPicked((prev) => {
        const next = new Map(prev);
        for (const f of added) next.set(f.id, f);
        return next;
      });
    }
    if (navigated) {
      setSearch('');
      setPath((prevPath) => [...prevPath, {
        id: navigated.id,
        name: navigated.name || 'Shared folder',
        resourceKey: navigated.resourceKey || '',
      }]);
    }
    setLinkReport({ added: added.length, failed, folder: Boolean(navigated) });
    if (failed.length === 0) setLinkText('');
    setLinkBusy(false);
  }, [linkText]);

  const toggle = (file) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  };

  const counts = useMemo(() => {
    const c = { video: 0, audio: 0, subtitle: 0 };
    for (const f of picked.values()) {
      const k = kindOf(f);
      if (k) c[k] += 1;
    }
    return c;
  }, [picked]);

  const totalBytes = useMemo(
    () => [...picked.values()].reduce((sum, f) => sum + (kindOf(f) === 'subtitle' ? 0 : f.size), 0),
    [picked],
  );

  if (!open) return null;

  const openFolder = (f) => {
    setSearch('');
    setPath((p) => [...p, { id: f.id, name: f.name, resourceKey: f.resourceKey || '' }]);
  };

  const crumbTo = (i) => {
    setSearch('');
    setPath((p) => p.slice(0, i + 1));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-panel">
        <header className="flex items-center justify-between gap-4 border-b border-edge px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Google Drive</h2>
            {auth.signedIn && auth.account?.email && (
              <p className="truncate text-xs text-neutral-500">{auth.account.email}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {auth.signedIn && (
              <button type="button" onClick={signOut} className="text-xs text-neutral-400 underline hover:text-white">
                Sign out
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">×</button>
          </div>
        </header>

        {!auth.configured ? (
          <div className="overflow-y-auto px-5 py-6">
            <p className="text-sm text-neutral-300">
              Drive needs a Google OAuth client ID. It identifies this copy of FrenFlix to
              Google, so it cannot be shipped in the repository — you make your own, once.
            </p>
            <ol className="mt-4 space-y-2 text-sm text-neutral-400">
              {SETUP_STEPS.map((s, i) => (
                <li key={s} className="flex gap-3">
                  <span className="shrink-0 text-neutral-600">{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-neutral-600">
              The scope requested is read-only. Nothing in this app writes to Drive.
            </p>
          </div>
        ) : !auth.signedIn ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-neutral-400">
              Sign in to browse your Drive. The token is kept in memory only and disappears
              when you close the tab.
            </p>
            <button
              type="button"
              onClick={() => signIn().catch((e) => setError(e.message))}
              className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              Connect Google Drive
            </button>
            {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
          </div>
        ) : (
          <>
            <div className="border-b border-edge px-5 py-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') resolveLinks(); }}
                  placeholder="Paste Drive links or file ids — several at once is fine"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600"
                />
                <button
                  type="button"
                  onClick={resolveLinks}
                  disabled={linkBusy || !linkText.trim()}
                  className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500 hover:text-white disabled:opacity-40"
                >
                  {linkBusy ? 'Checking…' : 'Add link'}
                </button>
              </div>
              {linkReport && (
                <div className="mt-2 space-y-1 text-xs">
                  {linkReport.added > 0 && (
                    <p className="text-emerald-400">
                      Selected {linkReport.added} file{linkReport.added === 1 ? '' : 's'} from the link
                      {linkReport.added === 1 ? '' : 's'}.
                    </p>
                  )}
                  {linkReport.folder && <p className="text-emerald-400">Opened the shared folder.</p>}
                  {linkReport.failed.map((f) => (
                    <p key={f.ref} className="text-amber-400">
                      <span className="text-amber-200/70">{f.ref.length > 40 ? `${f.ref.slice(0, 40)}…` : f.ref}</span>
                      {' — '}{f.message}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b border-edge px-5 py-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search all of Drive by name"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600"
              />
              {!search && (
                <nav className="flex min-w-0 items-center gap-1 text-xs text-neutral-500">
                  {path.map((c, i) => (
                    <span key={c.id} className="flex items-center gap-1">
                      {i > 0 && <span className="text-neutral-700">/</span>}
                      <button
                        type="button"
                        onClick={() => crumbTo(i)}
                        className={i === path.length - 1 ? 'text-neutral-300' : 'hover:text-white'}
                      >
                        {c.name}
                      </button>
                    </span>
                  ))}
                </nav>
              )}
            </div>

            <div className="min-h-[240px] flex-1 overflow-y-auto">
              {error && <p className="px-5 py-4 text-sm text-red-300">{error}</p>}
              {!error && items.length === 0 && !loading && (
                <p className="px-5 py-10 text-center text-sm text-neutral-500">
                  {search ? 'Nothing matched.' : 'No video, audio or subtitle files in this folder.'}
                </p>
              )}
              <ul className="divide-y divide-edge">
                {items.map((f) => {
                  const kind = kindOf(f);
                  const on = picked.has(f.id);
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => (f.isFolder ? openFolder(f) : toggle(f))}
                        className={`flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-white/5 ${on ? 'bg-accent/10' : ''}`}
                      >
                        {!f.isFolder && (
                          <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${on ? 'border-accent bg-accent text-white' : 'border-edge'}`}>
                            {on ? '✓' : ''}
                          </span>
                        )}
                        <span className="shrink-0 text-neutral-500">{f.isFolder ? '▸' : ''}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200" title={f.name}>{f.name}</span>
                        {kind && (
                          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${KIND_TAG[kind]}`}>{kind}</span>
                        )}
                        <span className="w-20 shrink-0 text-right text-xs text-neutral-600">
                          {f.isFolder ? '' : formatBytes(f.size)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {pageToken && (
                <div className="px-5 py-3">
                  <button
                    type="button"
                    onClick={() => load({ pageToken })}
                    disabled={loading}
                    className="text-sm text-neutral-400 underline hover:text-white"
                  >
                    {loading ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
              {loading && items.length === 0 && (
                <p className="px-5 py-10 text-center text-sm text-neutral-500">Loading…</p>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-5 py-3">
              <p className="text-xs text-neutral-500">
                {picked.size === 0 ? 'Nothing selected' : (
                  <>
                    {counts.video} video · {counts.audio} audio · {counts.subtitle} subtitle
                    {totalBytes > 0 && <> · {formatBytes(totalBytes)} to download</>}
                  </>
                )}
              </p>
              <div className="flex items-center gap-3">
                <button type="button" onClick={onClose} className="text-sm text-neutral-400 hover:text-white">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={picked.size === 0}
                  onClick={() => { onAdd([...picked.values()]); setPicked(new Map()); onClose(); }}
                  className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                >
                  Add {picked.size || ''} to library
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
