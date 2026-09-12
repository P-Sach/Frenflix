/**
 * Filename-based video/audio pairing.
 *
 * The common shape this exists for: a folder holds `Movie.mkv` alongside
 * `Movie.m4a`, or `Movie.1080p.WEB-DL.x265.mp4` alongside
 * `Movie (Hindi 5.1).eac3`. Same title, different release noise. We strip the
 * noise, compare what's left, and pair confidently when the remainder matches.
 *
 * Anything we can't pair confidently is handed back as unmatched, for the user
 * to pair by hand — the auto-matcher is allowed to give up, it is not allowed
 * to guess wrong.
 */

export const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'ts', 'm2ts', 'mpg', 'mpeg', 'ogv', '3gp', 'flv', 'wmv',
]);

export const AUDIO_EXT = new Set([
  'm4a', 'mp3', 'aac', 'opus', 'ogg', 'oga', 'flac', 'wav', 'ac3', 'eac3', 'dts', 'mka', 'wma',
]);

export const SUBTITLE_EXT = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'sbv']);

/** Subtitle formats we parse. ASS/SSA carry styling and positioning we ignore. */
export const RICH_SUBTITLE_EXT = new Set(['ass', 'ssa', 'sub', 'sbv']);

/** Containers the browser will refuse even though we happily list them. */
export const RISKY_VIDEO_EXT = new Set(['mkv', 'avi', 'ts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg', '3gp']);
export const RISKY_AUDIO_EXT = new Set(['ac3', 'eac3', 'dts', 'mka', 'wma']);

export function extensionOf(name = '') {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function stemOf(name = '') {
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(0, i);
}

/** 'video' | 'audio' | 'subtitle' | null */
export function classify(name = '') {
  const ext = extensionOf(name);
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (SUBTITLE_EXT.has(ext)) return 'subtitle';
  return null;
}

// Release-noise tokens. Dropped wholesale before comparison.
const NOISE = new Set([
  '480p', '576p', '720p', '1080p', '1440p', '2160p', '4k', '8k', 'uhd', 'hd', 'sd', 'fhd', 'qhd',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1', 'vp9', '10bit', '8bit', 'hi10p',
  'hdr', 'hdr10', 'dv', 'dolby', 'vision', 'sdr',
  'bluray', 'blu', 'ray', 'brrip', 'bdrip', 'bdremux', 'remux', 'webrip', 'web', 'dl', 'webdl',
  'hdrip', 'dvdrip', 'dvdscr', 'hdtv', 'pdtv', 'cam', 'ts', 'tc',
  'aac', 'ac3', 'eac3', 'ddp', 'dd', 'dts', 'hd', 'ma', 'truehd', 'atmos', 'opus', 'flac', 'mp3',
  '2ch', '6ch', '8ch', '51', '71', '20', 'stereo', 'mono', 'surround',
  'dual', 'audio', 'multi', 'subs', 'sub', 'esub', 'esubs', 'msubs', 'dubbed', 'dub', 'original',
  'proper', 'repack', 'extended', 'uncut', 'unrated', 'directors', 'director', 'cut', 'theatrical',
  'remastered', 'restored', 'complete', 'internal', 'limited',
  'yify', 'yts', 'rarbg', 'psa', 'evo', 'fgt', 'sparks', 'ntb', 'cmrg', 'galaxyrg', 'qxr', 'tigole',
  'track', 'audiotrack', 'sound', 'dubbing',
  // subtitle-file noise
  'forced', 'sdh', 'cc', 'subtitle', 'subtitles', 'caption', 'captions', 'full',
]);

/** Two-letter ISO language codes, common on subtitle files (Movie.en.srt). */
const LANG_CODES = new Set([
  'en', 'hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'ur', 'gu', 'or', 'as',
  'ja', 'ko', 'zh', 'fr', 'de', 'es', 'it', 'ru', 'pt', 'ar', 'tr', 'th', 'nl',
  'sv', 'no', 'da', 'fi', 'pl', 'cs', 'el', 'he', 'id', 'vi', 'ms', 'fa',
]);

// Language tags — dropped too, since the whole point is that the audio file is
// usually a *different language* than the video's embedded track.
const LANGUAGES = new Set([
  'hindi', 'english', 'eng', 'hin', 'tamil', 'tam', 'telugu', 'tel', 'malayalam', 'mal',
  'kannada', 'kan', 'bengali', 'ben', 'marathi', 'mar', 'punjabi', 'pun', 'urdu', 'guj', 'gujarati',
  'japanese', 'jpn', 'jap', 'korean', 'kor', 'chinese', 'chi', 'mandarin', 'cantonese',
  'french', 'fre', 'fra', 'german', 'ger', 'deu', 'spanish', 'spa', 'esp', 'italian', 'ita',
  'russian', 'rus', 'portuguese', 'por', 'arabic', 'ara', 'turkish', 'tur', 'thai', 'dutch', 'nld',
]);

/**
 * Reduce a filename to the bare title, for comparison only.
 */
export function normalizeTitle(filename = '') {
  const raw = stemOf(filename).toLowerCase();

  // A release year is the single most discriminating token in a filename, and
  // it is as likely to sit inside brackets — "Movie (2024)" — as outside them.
  // Pull it out before the bracket sweep so `Movie (2024) Hindi.eac3` and
  // `Movie.2024.1080p.mp4` normalize to the same string.
  const yearMatch = raw.match(/\b(?:19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;

  let s = raw;
  // Drop bracketed groups wholesale: [YTS.MX], (Hindi 5.1), {2160p}
  s = s.replace(/[[({][^\])}]*[\])}]/g, ' ');
  // Separators -> spaces. Keep digits: years and episode numbers matter.
  s = s.replace(/[._\-+~@#]+/g, ' ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');

  const tokens = s.split(/\s+/).filter(Boolean);
  const kept = [];
  for (const t of tokens) {
    if (NOISE.has(t) || LANGUAGES.has(t)) continue;
    // Two-letter codes are stripped only when something already precedes them,
    // so a film actually called "It" or "Up" keeps its title.
    if (kept.length > 0 && LANG_CODES.has(t)) continue;
    // Codec/channel tags that carry a trailing digit: ddp5, dd2, dts5, aac2
    if (/^(?:ddp?|dts|e?ac3|aac|mp3|flac|opus|truehd|atmos|h|x)\d+$/.test(t)) continue;
    // 5.1 / 7.1 survive the dot-stripping as "5" "1"; drop bare channel digits
    if (/^\d$/.test(t) && kept.length > 0) continue;
    kept.push(t);
  }
  if (year && !kept.includes(year)) kept.push(year);
  const out = kept.join(' ').trim();
  return out || raw.trim();
}

/** Season/episode marker, so S01E02 never pairs with S01E03. */
export function episodeKey(filename = '') {
  const s = stemOf(filename).toLowerCase();
  let m = s.match(/s(\d{1,2})[\s._-]*e(\d{1,3})/);
  if (m) return `s${Number(m[1])}e${Number(m[2])}`;
  m = s.match(/(\d{1,2})x(\d{1,3})\b/);
  if (m) return `s${Number(m[1])}e${Number(m[2])}`;
  return null;
}

function bigrams(s) {
  const set = new Map();
  const clean = s.replace(/\s+/g, '');
  for (let i = 0; i < clean.length - 1; i += 1) {
    const g = clean.slice(i, i + 2);
    set.set(g, (set.get(g) || 0) + 1);
  }
  return set;
}

/** Sørensen–Dice coefficient over character bigrams. 0..1 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const n of A.values()) totalA += n;
  for (const n of B.values()) totalB += n;
  if (!totalA || !totalB) return 0;
  for (const [g, n] of A) {
    const m = B.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (totalA + totalB);
}

export const AUTO_PAIR_THRESHOLD = 0.82;

/**
 * @param {Array<{id:string,name:string}>} videos
 * @param {Array<{id:string,name:string}>} audios
 * @returns {{pairs: Array, unmatchedVideos: Array, unmatchedAudios: Array}}
 */
export function autoPair(videos, audios) {
  const vMeta = videos.map((v) => ({ item: v, title: normalizeTitle(v.name), ep: episodeKey(v.name) }));
  const aMeta = audios.map((a) => ({ item: a, title: normalizeTitle(a.name), ep: episodeKey(a.name) }));

  const candidates = [];
  for (const v of vMeta) {
    for (const a of aMeta) {
      // Episode markers, when both have them, are a hard gate.
      if (v.ep && a.ep && v.ep !== a.ep) continue;
      const base = similarity(v.title, a.title);
      const exact = v.title === a.title;
      const epBonus = v.ep && a.ep && v.ep === a.ep ? 0.1 : 0;
      const score = Math.min(1, base + epBonus);
      if (exact || score >= AUTO_PAIR_THRESHOLD) {
        candidates.push({ v, a, score, exact });
      }
    }
  }

  // Greedy: best score first, each file used at most once.
  candidates.sort((x, y) => (y.exact - x.exact) || (y.score - x.score));

  const usedV = new Set();
  const usedA = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedV.has(c.v.item.id) || usedA.has(c.a.item.id)) continue;
    usedV.add(c.v.item.id);
    usedA.add(c.a.item.id);
    pairs.push({
      video: c.v.item,
      audio: c.a.item,
      title: c.v.title,
      confidence: c.score,
      reason: c.exact ? 'identical name' : `${Math.round(c.score * 100)}% name match`,
    });
  }

  return {
    pairs,
    unmatchedVideos: vMeta.filter((v) => !usedV.has(v.item.id)).map((v) => v.item),
    unmatchedAudios: aMeta.filter((a) => !usedA.has(a.item.id)).map((a) => a.item),
  };
}

/**
 * Attach a set of loose files to videos by name, many-to-one.
 *
 * Deliberately many-to-one for both audio and subtitles: a film often ships
 * with English, Hindi and forced-narrative tracks at once, and the right
 * behaviour is to offer all of them rather than whichever one matched first.
 * Results are sorted best-match-first, so the caller can treat index 0 as the
 * default track without a second decision.
 *
 * The bar is the same as `autoPair`'s: match confidently or hand it back for
 * manual pairing. The matcher is allowed to give up; it is not allowed to
 * guess wrong.
 *
 * @param {Array<{id:string,name:string}>} videos
 * @param {Array<{id:string,name:string}>} files
 * @returns {Record<string, Array<{id:string,score:number,reason:string}>>}
 */
export function matchToVideos(videos, files) {
  const vMeta = videos.map((v) => ({ item: v, title: normalizeTitle(v.name), ep: episodeKey(v.name) }));
  const out = {};

  for (const file of files) {
    const title = normalizeTitle(file.name);
    const ep = episodeKey(file.name);
    let best = null;
    let bestScore = 0;
    let exact = false;

    for (const v of vMeta) {
      // Episode markers, when both have them, are a hard gate.
      if (v.ep && ep && v.ep !== ep) continue;
      const isExact = v.title === title;
      const score = Math.min(1, similarity(v.title, title) + (v.ep && ep && v.ep === ep ? 0.1 : 0));
      if (score > bestScore || (isExact && !exact)) {
        bestScore = score;
        best = v;
        exact = isExact;
      }
    }

    if (best && (exact || bestScore >= AUTO_PAIR_THRESHOLD)) {
      (out[best.item.id] ||= []).push({
        id: file.id,
        score: exact ? 1 : bestScore,
        reason: exact ? 'identical name' : `${Math.round(bestScore * 100)}% name match`,
      });
    }
  }

  for (const list of Object.values(out)) list.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Subtitles, by the same rules. Kept as a named export because that is what it
 * reads as at the call site.
 *
 * @returns {Record<string, string[]>} videoId -> subtitle ids, best first
 */
export function matchSubtitles(videos, subs) {
  const matched = matchToVideos(videos, subs);
  const out = {};
  for (const [videoId, list] of Object.entries(matched)) out[videoId] = list.map((m) => m.id);
  return out;
}

/** Human-facing title: normalized, title-cased, year kept in parentheses. */
export function displayTitle(filename = '') {
  const norm = normalizeTitle(filename);
  const year = norm.match(/\b(19|20)\d{2}\b/);
  const withoutYear = year ? norm.replace(year[0], '').trim() : norm;
  const cased = withoutYear
    .split(' ')
    .filter(Boolean)
    .map((w) => {
      // Keep season/episode markers shouting: s01e02 -> S01E02
      if (/^s\d{1,2}e\d{1,3}$/.test(w)) return w.toUpperCase();
      if (w.length <= 2 && /^[a-z]+$/.test(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
  return year ? `${cased} (${year[0]})` : cased || stemOf(filename);
}
