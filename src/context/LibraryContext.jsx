import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
} from 'react';
import {
  classify, displayTitle, extensionOf, matchSubtitles, matchToVideos,
  RICH_SUBTITLE_EXT, RISKY_AUDIO_EXT, RISKY_VIDEO_EXT,
} from '../lib/pairing';
import {
  createDriveAsset, createDriveSubtitleAsset, createLocalAsset, createRestoredAsset,
  createRestoredSubtitleAsset, createSubtitleAsset, driveKey, localKey,
} from '../lib/sources';
import {
  filesInDirectory, handlesSupported, pickFiles, pickFolder, requestRead,
} from '../lib/handles';
import { flush as flushLibrary, forget as forgetLibrary, load as loadLibrary, save as saveLibrary } from '../lib/persist';

/**
 * The library is one atomic piece of state — videos, audios and the links
 * between them — because every mutation touches at least two of the three.
 * A reducer keeps it consistent and keeps the updaters pure (React StrictMode
 * runs them twice, so side effects inside them would double-add files).
 */
/**
 * `links` maps a video to a *list* of audio tracks, best match first, because a
 * film often arrives with several dubs and all of them belong in the menu.
 * Index 0 is the default; everything else is one click away in the player.
 */
const initialState = {
  videos: [], audios: [], subtitles: [], links: {}, subLinks: {}, rejected: [], queue: [],
  /**
   * The folder the library was pointed at, if any. One directory handle is
   * worth more than every file handle put together: a single permission grant
   * covers everything inside it, and it keeps covering files added later.
   */
  directory: null,
  /**
   * Assets are mutated in place when a file is reopened or dropped again —
   * the asset identity has to survive, because the whole graph refers to it.
   * That means the arrays do not change, so nothing would re-render. Bumping
   * this is how a mutation becomes visible.
   */
  revision: 0,
  /** Whether the saved library has been read yet. Nothing is saved before it has. */
  restored: false,
};

/** Remove one audio id from every video's track list. */
function withoutAudio(links, audioId) {
  const next = {};
  for (const [vid, list] of Object.entries(links)) {
    const kept = list.filter((t) => t.audioId !== audioId);
    if (kept.length) next[vid] = kept;
  }
  return next;
}

function reducer(state, action) {
  switch (action.type) {
    case 'add': {
      const videos = [...state.videos, ...action.videos];
      const audios = [...state.audios, ...action.audios];
      const subtitles = [...state.subtitles, ...action.subtitles];

      // Re-run matching over everything still unattached, not just the new
      // arrivals: dropping the Hindi dub for a video added ten minutes ago
      // should still find it.
      const linkedAudioIds = new Set(Object.values(state.links).flat().map((t) => t.audioId));
      const freeAudios = audios.filter((a) => !linkedAudioIds.has(a.id));

      const links = { ...state.links };
      for (const [videoId, matches] of Object.entries(matchToVideos(videos, freeAudios))) {
        links[videoId] = [
          ...(links[videoId] || []),
          ...matches.map((m) => ({ audioId: m.id, confidence: m.score, reason: m.reason })),
        ];
      }

      // Subtitles are many-to-one: a title can carry several language tracks.
      const alreadyLinked = new Set(Object.values(state.subLinks).flat());
      const freeSubs = subtitles.filter((x) => !alreadyLinked.has(x.id));
      const subLinks = { ...state.subLinks };
      for (const [videoId, ids] of Object.entries(matchSubtitles(videos, freeSubs))) {
        subLinks[videoId] = [...(subLinks[videoId] || []), ...ids];
      }

      return {
        ...state,
        videos, audios, subtitles, links, subLinks,
        rejected: [...state.rejected, ...action.skipped],
      };
    }

    case 'linkSub': {
      const subLinks = { ...state.subLinks };
      for (const [vid, ids] of Object.entries(subLinks)) {
        const filtered = ids.filter((id) => id !== action.subtitleId);
        if (filtered.length) subLinks[vid] = filtered;
        else delete subLinks[vid];
      }
      subLinks[action.videoId] = [...(subLinks[action.videoId] || []), action.subtitleId];
      return { ...state, subLinks };
    }

    case 'removeSub': {
      const subLinks = { ...state.subLinks };
      for (const [vid, ids] of Object.entries(subLinks)) {
        const filtered = ids.filter((id) => id !== action.subtitleId);
        if (filtered.length) subLinks[vid] = filtered;
        else delete subLinks[vid];
      }
      return { ...state, subtitles: state.subtitles.filter((x) => x.id !== action.subtitleId), subLinks };
    }

    case 'link': {
      // A hand-picked track belongs to this video and becomes its default —
      // choosing it in the pairing dialog is a statement about what to play.
      const links = withoutAudio(state.links, action.audioId);
      if (!action.audioId) {
        delete links[action.videoId];
        return { ...state, links };
      }
      links[action.videoId] = [
        { audioId: action.audioId, confidence: 1, reason: 'paired by hand' },
        ...(links[action.videoId] || []),
      ];
      return { ...state, links };
    }

    case 'setPrimaryAudio': {
      const list = state.links[action.videoId] || [];
      const chosen = list.find((t) => t.audioId === action.audioId);
      if (!chosen) return state;
      return {
        ...state,
        links: {
          ...state.links,
          [action.videoId]: [chosen, ...list.filter((t) => t.audioId !== action.audioId)],
        },
      };
    }

    case 'unlinkAudio':
      return { ...state, links: withoutAudio(state.links, action.audioId) };

    case 'unlink': {
      const links = { ...state.links };
      delete links[action.videoId];
      return { ...state, links };
    }

    case 'queueSet':
      return { ...state, queue: action.ids };

    case 'queueAdd':
      return state.queue.includes(action.id)
        ? state
        : { ...state, queue: [...state.queue, action.id] };

    case 'queueRemove':
      return { ...state, queue: state.queue.filter((id) => id !== action.id) };

    case 'queueMove': {
      const from = state.queue.indexOf(action.id);
      const to = from + action.delta;
      if (from === -1 || to < 0 || to >= state.queue.length) return state;
      const queue = [...state.queue];
      [queue[from], queue[to]] = [queue[to], queue[from]];
      return { ...state, queue };
    }

    case 'queueClear':
      return { ...state, queue: [] };

    case 'removeVideo': {
      const links = { ...state.links };
      delete links[action.videoId];
      const subLinks = { ...state.subLinks };
      delete subLinks[action.videoId];
      return {
        ...state,
        videos: state.videos.filter((v) => v.id !== action.videoId),
        links,
        subLinks,
        queue: state.queue.filter((id) => id !== action.videoId),
      };
    }

    case 'removeAudio':
      return {
        ...state,
        audios: state.audios.filter((a) => a.id !== action.audioId),
        links: withoutAudio(state.links, action.audioId),
      };

    /**
     * Everything that was saved, rebuilt.
     *
     * Replaces the state wholesale rather than merging: this runs once, before
     * the user can have touched anything, and a merge would have to resolve
     * conflicts that cannot exist.
     */
    case 'restore':
      // If anything was added before the read finished, the user wins: their
      // files are in front of them and a wholesale replace would take them
      // away. Restoring is a one-shot on an empty library or not at all.
      if (state.videos.length || state.audios.length || state.subtitles.length) {
        return { ...state, restored: true };
      }
      return {
        ...initialState,
        videos: action.videos,
        audios: action.audios,
        subtitles: action.subtitles,
        links: action.links,
        subLinks: action.subLinks,
        queue: action.queue,
        directory: action.directory || null,
        restored: true,
      };

    /** Nothing structural changed; an asset did. See `revision`. */
    case 'touch':
      return {
        ...state,
        videos: [...state.videos],
        audios: [...state.audios],
        subtitles: [...state.subtitles],
        revision: state.revision + 1,
      };

    case 'setDirectory':
      return { ...state, directory: action.directory };

    case 'ready':
      return state.restored ? state : { ...state, restored: true };

    case 'clear':
      return { ...initialState, restored: true };

    case 'dismissRejected':
      return { ...state, rejected: [] };

    default:
      return state;
  }
}

const LibraryContext = createContext(null);

/**
 * Turn a saved record back into live assets and a live graph.
 *
 * The saved graph is expressed in file fingerprints; the reducer works in
 * session ids, which are new every time the page loads. So the ids are minted
 * here and the fingerprints translated through them once.
 *
 * Drive titles come back genuinely ready: their bytes are in the origin
 * private file system already, so there is nothing to reopen and nothing to
 * ask. Local ones come back as assets without files — see `createRestoredAsset`
 * — carrying a handle when the browser gave one.
 */
function rebuild(snap) {
  const videos = [];
  const audios = [];
  const subtitles = [];
  const byKey = new Map();

  const make = (rec) => (rec.origin === 'drive'
    ? createDriveAsset({
      id: rec.fileId,
      name: rec.name,
      size: rec.size,
      mimeType: rec.mimeType,
      resourceKey: rec.resourceKey,
    }, rec.kind)
    : createRestoredAsset({
      key: rec.key,
      name: rec.name,
      kind: rec.kind,
      size: rec.size,
      handle: rec.handle || null,
    }));

  for (const rec of snap.videos || []) {
    if (!rec?.key) continue;
    const asset = make({ ...rec, kind: 'video' });
    videos.push(asset);
    byKey.set(rec.key, asset);
  }
  for (const rec of snap.audios || []) {
    if (!rec?.key) continue;
    const asset = make({ ...rec, kind: 'audio' });
    audios.push(asset);
    byKey.set(rec.key, asset);
  }
  for (const rec of snap.subtitles || []) {
    if (!rec?.key) continue;
    const asset = rec.origin === 'drive'
      ? createDriveSubtitleAsset({ id: rec.fileId, name: rec.name, resourceKey: rec.resourceKey })
      : createRestoredSubtitleAsset({ key: rec.key, name: rec.name, text: rec.text || '' });
    subtitles.push(asset);
    byKey.set(rec.key, asset);
  }

  const idOf = (key) => byKey.get(key)?.id;

  const links = {};
  for (const [videoKey, tracks] of Object.entries(snap.links || {})) {
    const videoId = idOf(videoKey);
    if (!videoId) continue;
    const list = (tracks || []).map((t) => {
      const audioId = idOf(t.audioKey);
      return audioId ? { audioId, confidence: t.confidence, reason: t.reason } : null;
    }).filter(Boolean);
    if (list.length) links[videoId] = list;
  }

  const subLinks = {};
  for (const [videoKey, keys] of Object.entries(snap.subLinks || {})) {
    const videoId = idOf(videoKey);
    if (!videoId) continue;
    const ids = (keys || []).map(idOf).filter(Boolean);
    if (ids.length) subLinks[videoId] = ids;
  }

  return {
    videos,
    audios,
    subtitles,
    links,
    subLinks,
    queue: (snap.queue || []).map(idOf).filter(Boolean),
    directory: snap.directory || null,
  };
}

/** A drop, a picker and a file input all reduce to this. */
function normalizePicks(input) {
  const arr = Array.isArray(input) ? input : Array.from(input || []);
  return arr
    .map((x) => (x && typeof x === 'object' && 'file' in x ? x : { file: x, handle: null }))
    .filter((x) => x.file && typeof x.file.name === 'string');
}

export function LibraryProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  /**
   * The latest state, for callbacks that must not be rebuilt on every change.
   * `addFiles` in particular is handed to a dozen components and needs to see
   * the current library to know whether a dropped file belongs to a title that
   * is already there.
   */
  const stateRef = useRef(state);
  stateRef.current = state;
  const [restoring, setRestoring] = useState(true);

  /** Ingest a FileList / File[] from a drop or a file input. */
  const addFiles = useCallback((input) => {
    const picks = normalizePicks(input);
    const current = stateRef.current;
    const byKey = new Map();
    for (const asset of [...current.videos, ...current.audios, ...current.subtitles]) {
      if (asset.key) byKey.set(asset.key, asset);
    }

    const videos = [];
    const audios = [];
    const subtitles = [];
    const skipped = [];
    const reattached = [];

    for (const { file, handle } of picks) {
      const kind = classify(file.name);
      if (!kind) { skipped.push(file.name); continue; }

      /*
       * The same file again.
       *
       * After a reload a title is here in every respect except its bytes —
       * name, pairings, subtitle tracks, poster art, watch position. Dropping
       * the file back in has to give those bytes to the asset the whole graph
       * already points at, not create a second copy of the title beside it.
       * The fingerprint (name, size, last-modified) is what makes them the
       * same file; see `localKey`.
       */
      const existing = byKey.get(localKey(file));
      if (existing) {
        if (typeof existing.attach === 'function' && !existing.ready) {
          existing.attach(file, handle);
          reattached.push(existing);
        }
        continue;                          // already known, either way
      }

      if (kind === 'video') videos.push(createLocalAsset(file, 'video', handle));
      else if (kind === 'audio') audios.push(createLocalAsset(file, 'audio', handle));
      else {
        const sub = createSubtitleAsset(file, handle);
        // Read it now rather than on first use. It is kilobytes, and having the
        // text on the asset is what lets the saved library carry subtitle
        // tracks that come back needing no file and no permission.
        sub.loadCues().catch(() => {});
        subtitles.push(sub);
      }
    }

    if (videos.length || audios.length || subtitles.length || skipped.length) {
      dispatch({ type: 'add', videos, audios, subtitles, skipped });
    }
    if (reattached.length) dispatch({ type: 'touch' });
    // Callers sometimes need the new assets themselves — dropping a subtitle
    // onto the watch page attaches it to *that* title regardless of its name.
    return { videos, audios, subtitles, skipped, reattached };
  }, []);

  /**
   * Ingest files chosen in Drive. Same three buckets and the same auto-pairing
   * as a drop: the matcher works on names, and a Drive file has a name, so a
   * video in one folder pairs with a dub track in another without being told.
   * Nothing is downloaded here — that happens when a title is played.
   */
  const addDriveFiles = useCallback((driveFiles) => {
    const current = stateRef.current;
    // A Drive title restored from the saved library is already here, and the
    // browser dialog will happily offer it again.
    const known = new Set(
      [...current.videos, ...current.audios, ...current.subtitles].map((a) => a.key),
    );
    const videos = [];
    const audios = [];
    const subtitles = [];
    const skipped = [];

    for (const f of driveFiles || []) {
      if (known.has(driveKey(f.id))) continue;
      const byName = classify(f.name);
      const kind = byName
        || (f.mimeType?.startsWith('video/') && 'video')
        || (f.mimeType?.startsWith('audio/') && 'audio')
        || null;
      if (kind === 'video') videos.push(createDriveAsset(f, 'video'));
      else if (kind === 'audio') audios.push(createDriveAsset(f, 'audio'));
      else if (kind === 'subtitle') subtitles.push(createDriveSubtitleAsset(f));
      else skipped.push(f.name);
    }

    dispatch({ type: 'add', videos, audios, subtitles, skipped });
    return { videos, audios, subtitles, skipped };
  }, []);

  const linkPair = useCallback((videoId, audioId) => dispatch({ type: 'link', videoId, audioId }), []);
  const setPrimaryAudio = useCallback((videoId, audioId) => dispatch({ type: 'setPrimaryAudio', videoId, audioId }), []);
  const unlinkAudio = useCallback((audioId) => dispatch({ type: 'unlinkAudio', audioId }), []);
  const queueSet = useCallback((ids) => dispatch({ type: 'queueSet', ids }), []);
  const queueAdd = useCallback((id) => dispatch({ type: 'queueAdd', id }), []);
  const queueRemove = useCallback((id) => dispatch({ type: 'queueRemove', id }), []);
  const queueMove = useCallback((id, delta) => dispatch({ type: 'queueMove', id, delta }), []);
  const queueClear = useCallback(() => dispatch({ type: 'queueClear' }), []);
  const linkSubtitle = useCallback((videoId, subtitleId) => dispatch({ type: 'linkSub', videoId, subtitleId }), []);
  const removeSubtitle = useCallback((subtitleId) => dispatch({ type: 'removeSub', subtitleId }), []);
  const unlinkPair = useCallback((videoId) => dispatch({ type: 'unlink', videoId }), []);
  const dismissRejected = useCallback(() => dispatch({ type: 'dismissRejected' }), []);

  const removeVideo = useCallback((videoId) => {
    state.videos.find((v) => v.id === videoId)?.release?.();
    dispatch({ type: 'removeVideo', videoId });
  }, [state.videos]);

  const removeAudio = useCallback((audioId) => {
    state.audios.find((a) => a.id === audioId)?.release?.();
    dispatch({ type: 'removeAudio', audioId });
  }, [state.audios]);

  const clearAll = useCallback(() => {
    state.videos.forEach((v) => v.release?.());
    state.audios.forEach((a) => a.release?.());
    forgetLibrary();
    dispatch({ type: 'clear' });
  }, [state.videos, state.audios]);

  // ------------------------------------------------------- across sessions

  /**
   * Read the saved library once, on the way in.
   *
   * Two passes, and the order matters. First the graph, so the shelves are
   * populated immediately — with poster art, since that is cached against the
   * same fingerprints. Then the handles whose permission happens to have
   * survived, which needs no gesture and no prompt, so a returning user often
   * finds everything simply working.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snap = await loadLibrary().catch(() => null);
      if (cancelled) return;
      if (!snap) {
        dispatch({ type: 'ready' });
        setRestoring(false);
        return;
      }
      const built = rebuild(snap);
      dispatch({ type: 'restore', ...built });

      const withHandles = [...built.videos, ...built.audios].filter((a) => a.handle && !a.ready);
      if (withHandles.length === 0) { setRestoring(false); return; }
      const opened = await Promise.all(withHandles.map((a) => a.reopen().catch(() => false)));
      if (cancelled) return;
      if (opened.some(Boolean)) dispatch({ type: 'touch' });
      setRestoring(false);
    })();
    return () => { cancelled = true; };
  }, []);

  /** Write it back on every change, coalesced. Never before it has been read. */
  useEffect(() => {
    if (!state.restored) return undefined;
    saveLibrary(state, state.directory);
    return undefined;
  }, [state]);

  /** `pagehide` rather than `unload`: reliable, and does not block the bfcache. */
  useEffect(() => {
    const onHide = () => { flushLibrary(); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  /**
   * Ask the browser for the files back. Must be called from a click.
   *
   * A folder is the case worth having: one prompt, and every title inside it
   * comes back at once — including ones added to that folder since. Individual
   * file handles cannot work that way, because the browser spends the click's
   * user activation on the first prompt it shows, so they are offered one at a
   * time and the caller is told how many are left.
   *
   * Nothing is awaited before the request itself, deliberately: an await can
   * cost the user activation the request needs.
   */
  const restoreAccess = useCallback(async () => {
    const current = stateRef.current;
    const locals = [...current.videos, ...current.audios];
    const locked = locals.filter((a) => a.availability === 'locked');

    if (current.directory) {
      const granted = await requestRead(current.directory);
      if (granted === 'granted') {
        const picks = await filesInDirectory(current.directory);
        const byKey = new Map(locals.map((a) => [a.key, a]));
        let count = 0;
        for (const pick of picks) {
          const asset = byKey.get(localKey(pick.file));
          if (asset && !asset.ready) { asset.attach(pick.file, pick.handle); count += 1; }
        }
        // Files added to that folder since last time are new titles.
        const known = new Set(locals.map((a) => a.key));
        const fresh = picks.filter((p) => !known.has(localKey(p.file)));
        if (count) dispatch({ type: 'touch' });
        if (fresh.length) addFiles(fresh);
        return { granted: count, added: fresh.length, remaining: locked.length - count };
      }
      return { granted: 0, added: 0, remaining: locked.length };
    }

    let count = 0;
    for (const asset of locked) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await asset.reopen({ ask: true });
      if (ok) count += 1;
      else break;                       // the gesture is spent; one click, one file
    }
    if (count) dispatch({ type: 'touch' });
    return { granted: count, added: 0, remaining: locked.length - count };
  }, [addFiles]);

  /** Point the library at a folder — the entry point worth preferring. */
  const addFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return null;
    dispatch({ type: 'setDirectory', directory: picked.directory });
    return addFiles(picked.picks);
  }, [addFiles]);

  /**
   * The explicit file picker. Worth offering next to the drop zone for one
   * reason only: a `<input type="file">` yields no handles, so files chosen
   * that way cannot come back on their own in a later session.
   */
  const addViaPicker = useCallback(async () => {
    const picks = await pickFiles();
    if (picks.length === 0) return null;
    return addFiles(picks);
  }, [addFiles]);

  /** One row per video: the unit the library grid and the player deal in. */
  const entries = useMemo(() => {
    const byId = new Map(state.audios.map((a) => [a.id, a]));
    const subById = new Map(state.subtitles.map((x) => [x.id, x]));
    return state.videos.map((video) => {
      const list = state.links[video.id] || [];
      const audioTracks = list
        .map((t) => { const a = byId.get(t.audioId); return a ? { ...t, asset: a } : null; })
        .filter(Boolean);
      const audio = audioTracks[0]?.asset || null;
      const subtitles = (state.subLinks[video.id] || []).map((id) => subById.get(id)).filter(Boolean);
      const vExt = extensionOf(video.name);
      const aExt = audio ? extensionOf(audio.name) : '';
      return {
        id: video.id,
        title: displayTitle(video.name),
        video,
        audio,
        audioTracks,
        subtitles,
        confidence: audioTracks[0]?.confidence ?? 0,
        reason: audioTracks[0]?.reason ?? null,
        fromDrive: video.origin === 'drive' || audio?.origin === 'drive',
        /**
         * 'ready' | 'locked' | 'missing' — whether this title can play right
         * now, and if not, what it is waiting for. A Drive title is always
         * ready: its bytes are on this device already, or will be fetched.
         */
        availability: video.availability || 'ready',
        playable: (video.availability || 'ready') === 'ready',
        warnings: [
          RISKY_VIDEO_EXT.has(vExt) && `.${vExt} usually will not play in a browser`,
          audio && RISKY_AUDIO_EXT.has(aExt) && `.${aExt} audio usually will not decode in a browser`,
          subtitles.some((x) => RICH_SUBTITLE_EXT.has(extensionOf(x.name)))
            && 'styled subtitle formats (.ass/.ssa) render as plain text',
        ].filter(Boolean),
      };
    });
    // `state.revision` is in here on purpose: reopening a file mutates the
    // asset in place, and nothing else about the state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.videos, state.audios, state.subtitles, state.links, state.subLinks, state.revision]);

  /**
   * What the library is waiting for, if anything. Drive titles never appear
   * here — their bytes live on this device already.
   */
  const availability = useMemo(() => {
    const locals = [...state.videos, ...state.audios].filter((a) => a.origin === 'local');
    const locked = locals.filter((a) => a.availability === 'locked').length;
    const missing = locals.filter((a) => a.availability === 'missing').length;
    return {
      locked,
      missing,
      waiting: locked + missing,
      folder: Boolean(state.directory),
      restoring,
      supported: handlesSupported,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.videos, state.audios, state.directory, state.revision, restoring]);

  const looseAudios = useMemo(() => {
    const linked = new Set(Object.values(state.links).flat().map((t) => t.audioId));
    return state.audios.filter((a) => !linked.has(a.id));
  }, [state.audios, state.links]);

  const looseSubtitles = useMemo(() => {
    const linked = new Set(Object.values(state.subLinks).flat());
    return state.subtitles.filter((x) => !linked.has(x.id));
  }, [state.subtitles, state.subLinks]);

  const getEntry = useCallback((id) => entries.find((e) => e.id === id) || null, [entries]);

  /**
   * What plays when this one ends.
   *
   * An explicit queue wins. With no queue, the library's own order is the
   * playlist — which is what people expect from a folder of episodes, and it
   * means auto-advance works without anyone having to build a playlist first.
   */
  const nextAfter = useCallback((id) => {
    const order = state.queue.length ? state.queue : entries.map((e) => e.id);
    const i = order.indexOf(id);
    if (i === -1 || i === order.length - 1) return null;
    return order[i + 1];
  }, [state.queue, entries]);

  const prevBefore = useCallback((id) => {
    const order = state.queue.length ? state.queue : entries.map((e) => e.id);
    const i = order.indexOf(id);
    return i > 0 ? order[i - 1] : null;
  }, [state.queue, entries]);

  const value = useMemo(() => ({
    entries,
    queue: state.queue,
    looseAudios,
    looseSubtitles,
    audios: state.audios,
    subtitles: state.subtitles,
    rejected: state.rejected,
    addFiles,
    addDriveFiles,
    addFolder,
    addViaPicker,
    availability,
    restoreAccess,
    restored: state.restored,
    linkPair,
    unlinkPair,
    linkSubtitle,
    removeSubtitle,
    removeVideo,
    removeAudio,
    clearAll,
    dismissRejected,
    getEntry,
    setPrimaryAudio,
    unlinkAudio,
    queueSet,
    queueAdd,
    queueRemove,
    queueMove,
    queueClear,
    nextAfter,
    prevBefore,
  }), [entries, state.queue, looseAudios, looseSubtitles, state.audios, state.subtitles,
    state.rejected, state.restored, addFiles, addDriveFiles, addFolder, addViaPicker,
    availability, restoreAccess, linkPair, unlinkPair, linkSubtitle, removeSubtitle,
    removeVideo, removeAudio, clearAll, dismissRejected, getEntry, setPrimaryAudio, unlinkAudio,
    queueSet, queueAdd, queueRemove, queueMove, queueClear, nextAfter, prevBefore]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside <LibraryProvider>');
  return ctx;
}
