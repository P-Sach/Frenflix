/**
 * Turning a pasted Drive link into something the API can be asked about.
 *
 * Drive hands out at least six URL shapes for the same thing, and people paste
 * them with a trailing `?usp=sharing`, inside a sentence, or several at once —
 * which is the useful case here, since a title is often a video link plus a dub
 * track link plus a subtitle link sent in the same message.
 *
 * Two details that are easy to miss and both cause "it just says not found":
 *
 *   - A Docs/Sheets/Slides URL looks like a file link but there are no bytes
 *     behind it, so it is recognised and reported rather than attempted.
 *   - A file shared by link before Google's 2021 security update needs a
 *     **resource key**, which lives in the URL as `?resourcekey=…`. Without it
 *     the API answers 404 even though the link works in a browser. So the key
 *     is parsed here and carried all the way to the download.
 *     https://developers.google.com/workspace/drive/api/guides/resource-keys
 */

/** Base64url-ish. Inside a URL the surrounding path makes a short id unambiguous. */
const IN_URL = '[A-Za-z0-9_-]{10,}';

/**
 * A bare id pasted on its own has no surrounding URL to disambiguate it, so it
 * is matched on shape: long, and carrying both an upper-case letter and a
 * digit. Length alone is not enough — `garbage-not-a-link-at-all` is sixteen
 * legal base64url characters and was happily accepted as an id before this.
 * Drive ids are random base64url of 28+ characters, so the odds of a real one
 * having neither an upper-case letter nor a digit are about one in a million.
 */
const BARE_ID = /^(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{16,}$/;

const PATTERNS = [
  // Order matters: /folders/ can co-occur with an ?id= from a redirect.
  { kind: 'folder', re: new RegExp(`/folders/(${IN_URL})`) },
  { kind: 'file', re: new RegExp(`/file/d/(${IN_URL})`) },
  { kind: 'native', re: new RegExp(`/(?:document|spreadsheets|presentation|forms|drawings)/d/(${IN_URL})`) },
  { kind: 'folder', re: new RegExp(`folderview\\?[^#]*\\bid=(${IN_URL})`) },
  { kind: 'file', re: new RegExp(`[?&]id=(${IN_URL})`) },
];

const RESOURCE_KEY = /[?&]resourcekey=([A-Za-z0-9_-]+)/i;

const looksLikeUrl = (s) => /^(https?:)?\/\//i.test(s) || /^(www\.)?(drive|docs)\.google\.com/i.test(s);

/**
 * @param {string} token one link or id, already trimmed
 * @returns {{kind:'file'|'folder'|'native', id:string, resourceKey:string}|null}
 */
export function parseDriveRef(token) {
  const text = String(token || '').trim().replace(/^[<("']+|[>)"'.,]+$/g, '');
  if (!text) return null;

  const resourceKey = text.match(RESOURCE_KEY)?.[1] || '';

  for (const { kind, re } of PATTERNS) {
    const m = text.match(re);
    if (m) return { kind, id: m[1], resourceKey };
  }

  // A URL we could not read is a mistake worth reporting, not a bare id.
  if (looksLikeUrl(text) || text.includes('/')) return null;
  if (BARE_ID.test(text)) return { kind: 'file', id: text, resourceKey };
  return null;
}

/**
 * Parse a whole pasted blob — newlines, spaces or commas between entries.
 *
 * @returns {{refs: Array, bad: string[]}} refs deduped by id, in paste order
 */
export function parseDriveRefs(text) {
  const tokens = String(text || '').split(/[\s,]+/).filter(Boolean);
  const refs = [];
  const bad = [];
  const seen = new Set();

  for (const token of tokens) {
    const ref = parseDriveRef(token);
    if (!ref) {
      // Fragments of a link that was split on a comma inside its query string
      // are not worth reporting as separate failures.
      if (token.length > 6) bad.push(token);
      continue;
    }
    if (seen.has(ref.id)) {
      // A later copy may carry the resource key the first one lacked.
      const prior = refs.find((r) => r.id === ref.id);
      if (prior && !prior.resourceKey && ref.resourceKey) prior.resourceKey = ref.resourceKey;
      continue;
    }
    seen.add(ref.id);
    refs.push(ref);
  }

  return { refs, bad };
}

/**
 * The header value Drive wants for link-shared files: `id/key` pairs, comma
 * separated. Entries without a key are left out — sending an empty one is an
 * error, not a no-op.
 */
export function resourceKeyHeader(entries = []) {
  const pairs = entries
    .filter((e) => e && e.id && e.resourceKey)
    .map((e) => `${e.id}/${e.resourceKey}`);
  return pairs.length ? pairs.join(',') : '';
}
