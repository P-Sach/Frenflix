import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import {
  classify, displayTitle, extensionOf, matchSubtitles, matchToVideos,
  RICH_SUBTITLE_EXT, RISKY_AUDIO_EXT, RISKY_VIDEO_EXT,
} from '../lib/pairing';
import {
  createDriveAsset, createDriveSubtitleAsset, createLocalAsset, createSubtitleAsset,
} from '../lib/sources';

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

    case 'clear':
      return initialState;

    case 'dismissRejected':
      return { ...state, rejected: [] };

    default:
      return state;
  }
}

const LibraryContext = createContext(null);

export function LibraryProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  /** Ingest a FileList / File[] from a drop or a file input. */
  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList || []);
    const videos = [];
    const audios = [];
    const subtitles = [];
    const skipped = [];

    for (const file of incoming) {
      const kind = classify(file.name);
      if (kind === 'video') videos.push(createLocalAsset(file, 'video'));
      else if (kind === 'audio') audios.push(createLocalAsset(file, 'audio'));
      else if (kind === 'subtitle') subtitles.push(createSubtitleAsset(file));
      else skipped.push(file.name);
    }

    dispatch({ type: 'add', videos, audios, subtitles, skipped });
    // Callers sometimes need the new assets themselves — dropping a subtitle
    // onto the watch page attaches it to *that* title regardless of its name.
    return { videos, audios, subtitles, skipped };
  }, []);

  /**
   * Ingest files chosen in Drive. Same three buckets and the same auto-pairing
   * as a drop: the matcher works on names, and a Drive file has a name, so a
   * video in one folder pairs with a dub track in another without being told.
   * Nothing is downloaded here — that happens when a title is played.
   */
  const addDriveFiles = useCallback((driveFiles) => {
    const videos = [];
    const audios = [];
    const subtitles = [];
    const skipped = [];

    for (const f of driveFiles || []) {
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
    dispatch({ type: 'clear' });
  }, [state.videos, state.audios]);

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
        warnings: [
          RISKY_VIDEO_EXT.has(vExt) && `.${vExt} usually will not play in a browser`,
          audio && RISKY_AUDIO_EXT.has(aExt) && `.${aExt} audio usually will not decode in a browser`,
          subtitles.some((x) => RICH_SUBTITLE_EXT.has(extensionOf(x.name)))
            && 'styled subtitle formats (.ass/.ssa) render as plain text',
        ].filter(Boolean),
      };
    });
  }, [state.videos, state.audios, state.subtitles, state.links, state.subLinks]);

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
    state.rejected, addFiles, addDriveFiles, linkPair, unlinkPair, linkSubtitle, removeSubtitle,
    removeVideo, removeAudio, clearAll, dismissRejected, getEntry, setPrimaryAudio, unlinkAudio,
    queueSet, queueAdd, queueRemove, queueMove, queueClear, nextAfter, prevBefore]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside <LibraryProvider>');
  return ctx;
}
