/**
 * The Drive REST calls this app makes. There are three.
 *
 * Why there is no direct playback URL here
 * ----------------------------------------
 * The obvious design — point `<video src>` at Drive and let the browser stream
 * it — cannot be made to work from a page, and it is worth writing down why so
 * nobody spends another afternoon on it:
 *
 *   - `files.get?alt=media` needs `Authorization: Bearer …`. A media element
 *     sends no such header and offers no way to add one.
 *   - Fetching it by hand instead runs into the other half: Drive's CORS
 *     response permits `Authorization` but *not* `Range`, so the preflight for
 *     a partial request fails and the browser cancels it. No ranged reads means
 *     no seeking and no streaming — a media element's entire access pattern.
 *   - The old `drive.google.com/uc?export=download` style link does serve ranges
 *     to a media element, but only for files shared publicly, through an
 *     undocumented host that redirects through a virus-scan interstitial for
 *     large files. Not something to build on.
 *
 * What is left is one plain unranged GET of the whole file, which CORS does
 * allow. So `cache.js` streams that GET to disk once and everything above this
 * layer then deals with an ordinary local file — which is exactly the shape
 * `sources.js` was built around, so the player, the pairing and the sync engine
 * did not change by a line for this.
 */

import { ensureToken } from './auth.js';
import { FOLDER_MIME, NATIVE_PREFIX } from './config.js';
import { resourceKeyHeader } from './links.js';

const API = 'https://www.googleapis.com/drive/v3';

const FIELDS = 'nextPageToken, files(id, name, mimeType, size, modifiedTime, resourceKey, '
  + 'shortcutDetails(targetId, targetMimeType))';

/** Drive query strings are single-quoted, so an apostrophe in a name needs escaping. */
const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * @param {Array<{id:string,resourceKey:string}>} keyed files whose resource key
 *   has to travel with the request — see links.js.
 */
async function call(path, params = {}, keyed = []) {
  const token = await ensureToken();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { Authorization: `Bearer ${token}` };
  const rk = resourceKeyHeader(keyed);
  if (rk) headers['X-Goog-Drive-Resource-Keys'] = rk;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
    if (res.status === 401) throw new Error('Google rejected the token. Sign in again.');
    if (res.status === 403 && /rate|quota/i.test(detail)) {
      throw new Error('Drive is rate-limiting this app. Wait a moment and retry.');
    }
    // Drive answers 404 both for "no such file" and for "you cannot see it",
    // which is a confusing thing to show someone holding a working link. The
    // usual cause is a link-shared file whose resource key is missing.
    if (res.status === 404) {
      throw new Error('Drive says that file does not exist, or that this account cannot see it. '
        + 'If it came from a share link, paste the whole link rather than just the id — '
        + 'older link-shared files carry a resourcekey that is needed to read them.');
    }
    throw new Error(detail || `Drive request failed (${res.status}).`);
  }
  return res.json();
}

/**
 * One page of a folder's contents, or of a search.
 *
 * @param {{folderId?: string, search?: string, pageToken?: string}} opts
 */
export async function listFiles({ folderId = 'root', search = '', pageToken = '', resourceKey = '' } = {}) {
  const terms = ['trashed = false'];
  if (search.trim()) terms.push(`name contains '${quote(search.trim())}'`);
  else terms.push(`'${quote(folderId)}' in parents`);

  const body = await call('/files', {
    q: terms.join(' and '),
    fields: FIELDS,
    pageSize: 100,
    // Ordering by folder first is what makes a file list feel like a file list.
    orderBy: search.trim() ? 'name' : 'folder,name',
    pageToken,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    corpora: 'allDrives',
    spaces: 'drive',
  }, [{ id: folderId, resourceKey }]);

  return {
    nextPageToken: body.nextPageToken || '',
    // Children of a link-shared folder each carry their own key, which Drive
    // returns in the `resourceKey` field now that FIELDS asks for it.
    files: (body.files || []).map((f) => normalise(f)),
  };
}

export async function getFile(fileId, resourceKey = '') {
  const body = await call(`/files/${encodeURIComponent(fileId)}`, {
    fields: 'id, name, mimeType, size, modifiedTime, resourceKey, '
      + 'shortcutDetails(targetId, targetMimeType)',
    supportsAllDrives: 'true',
  }, [{ id: fileId, resourceKey }]);
  // The key from the pasted link is kept when Drive does not echo one back:
  // it is still needed for the download that follows.
  return normalise(body, resourceKey);
}

/**
 * Flatten the two things Drive can hand back for one entry: a real file, or a
 * shortcut pointing at one. Everything downstream only ever wants the target.
 */
function normalise(f, fallbackResourceKey = '') {
  const isShortcut = f.mimeType === 'application/vnd.google-apps.shortcut';
  const id = isShortcut ? (f.shortcutDetails?.targetId || f.id) : f.id;
  const mimeType = isShortcut ? (f.shortcutDetails?.targetMimeType || f.mimeType) : f.mimeType;
  return {
    id,
    name: f.name,
    mimeType,
    size: Number(f.size || 0),
    modifiedTime: f.modifiedTime || '',
    resourceKey: f.resourceKey || fallbackResourceKey || '',
    isFolder: mimeType === FOLDER_MIME,
    /** Docs, Sheets and friends have no bytes to download. */
    isNative: mimeType.startsWith(NATIVE_PREFIX) && mimeType !== FOLDER_MIME,
  };
}

/** The one endpoint that returns bytes. Requires the Authorization header. */
export function mediaUrl(fileId) {
  return `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

/** Small files — subtitles — are simple enough to read straight into memory. */
export async function fetchSmallFile(fileId, resourceKey = '') {
  const token = await ensureToken();
  const headers = { Authorization: `Bearer ${token}` };
  const rk = resourceKeyHeader([{ id: fileId, resourceKey }]);
  if (rk) headers['X-Goog-Drive-Resource-Keys'] = rk;
  const res = await fetch(mediaUrl(fileId), { headers });
  if (!res.ok) throw new Error(`Could not download from Drive (${res.status}).`);
  return res.blob();
}
