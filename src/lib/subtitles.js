/**
 * Subtitle parsing for SRT and WebVTT.
 *
 * We parse into our own cue list and render them ourselves rather than handing
 * a <track> to the browser, for three reasons: a delay control needs to shift
 * every cue live (VLC's g/h keys), native cue styling is barely controllable,
 * and the overlay has to live inside the element that goes fullscreen.
 */

const TAG_WHITELIST = /&lt;(\/?)(i|b|u)&gt;/g;

/** Escape everything, then let a tiny whitelist of formatting tags back in. */
function toSafeHtml(raw) {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(TAG_WHITELIST, '<$1$2>')
    .replace(/\r?\n/g, '<br>');
}

/** Strip formatting the renderer doesn't honour: ASS overrides, font tags. */
function stripUnsupported(raw) {
  return raw
    .replace(/\{\\[^}]*\}/g, '')          // {\an8}, {\pos(...)}
    .replace(/<\/?font[^>]*>/gi, '')
    .trim();
}

function parseTimestamp(stamp) {
  // 00:01:02,345 (SRT) or 00:01:02.345 / 01:02.345 (VTT)
  const m = stamp.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  const [, h, mm, ss, ms] = m;
  return (Number(h || 0) * 3600)
    + (Number(mm) * 60)
    + Number(ss)
    + Number(ms.padEnd(3, '0')) / 1000;
}

/**
 * @param {string} text raw file contents
 * @returns {Array<{start:number,end:number,html:string,text:string}>}
 */
export function parseSubtitles(text) {
  if (!text) return [];
  const body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = body.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;          // header
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;

    // The timing line may be the first or second line (SRT puts an index first,
    // VTT may put an optional cue identifier there).
    let timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    const [fromRaw, toRaw] = lines[timingIndex].split('-->');
    if (!fromRaw || !toRaw) continue;
    const start = parseTimestamp(fromRaw);
    // VTT allows cue settings after the end time: "00:00:04.000 line:90%"
    const end = parseTimestamp(toRaw.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const raw = stripUnsupported(lines.slice(timingIndex + 1).join('\n'));
    if (!raw) continue;

    cues.push({ start, end: Math.max(end, start + 0.2), html: toSafeHtml(raw), text: raw });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/**
 * Read a subtitle file as text.
 *
 * Subtitle files in the wild are frequently *not* UTF-8 — Latin-1 and
 * Windows-1252 are everywhere, and a mis-decode shows up as replacement
 * characters rather than as an error. So decode strictly first and fall back
 * when that fails.
 */
export async function readSubtitleFile(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buffer);
    } catch {
      return new TextDecoder().decode(buffer);
    }
  }
}

/** Binary search for the cue covering `time`, so this stays cheap per frame. */
export function cueAt(cues, time) {
  let lo = 0;
  let hi = cues.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (time < cue.start) hi = mid - 1;
    else if (time > cue.end) lo = mid + 1;
    else { found = cue; break; }
  }
  return found;
}
