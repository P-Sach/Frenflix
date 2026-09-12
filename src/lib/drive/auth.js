/**
 * Google sign-in, using Google Identity Services' token flow.
 *
 * The token lives in memory and nowhere else. Putting an OAuth access token in
 * localStorage would leave a key to somebody's entire Drive sitting on disk for
 * any script on the origin to read; an hour-long token held in a closure dies
 * with the tab, and re-consent is one silent request away while the Google
 * session is alive.
 *
 * There is no refresh token, deliberately. The implicit token flow does not
 * issue one — that is the trade for being able to run with no server at all.
 * What it does give is a silent re-request: as long as the user still has a
 * Google session and has already consented, asking again with an empty `prompt`
 * returns a new token with no interaction, which is what `ensureToken` does
 * when the current one is close to expiry.
 */

import { CLIENT_ID, SCOPE, GIS_SRC, isConfigured } from './config.js';

/** Ask for a new token this long before the current one runs out. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let scriptPromise = null;
let tokenClient = null;
let token = null;          // { value, expiresAt }
let account = null;        // { email, name, picture } once we've looked
let pending = null;        // in-flight requestAccessToken
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn(snapshot()));

export function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function snapshot() {
  return {
    configured: isConfigured,
    signedIn: Boolean(token && token.expiresAt > Date.now()),
    expiresAt: token?.expiresAt ?? 0,
    account,
  };
}

function loadScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const el = document.createElement('script');
    el.src = GIS_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Could not load Google sign-in. Check the network and any content blocker.'));
    document.head.appendChild(el);
  });
  return scriptPromise;
}

async function client() {
  if (tokenClient) return tokenClient;
  if (!isConfigured) throw new Error('No Google client ID configured.');
  await loadScript();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    // Set per request, because the same client is reused for the interactive
    // sign-in and for every silent refresh after it.
    callback: () => {},
  });
  return tokenClient;
}

/**
 * @param {boolean} interactive false asks Google to answer only if it can do so
 *   without showing anything — used for refreshes, where a popup out of nowhere
 *   would be worse than a failure we can report.
 */
function request(interactive) {
  if (pending) return pending;
  pending = client().then((tc) => new Promise((resolve, reject) => {
    tc.callback = (response) => {
      pending = null;
      if (response.error) {
        reject(new Error(describe(response.error)));
        return;
      }
      token = {
        value: response.access_token,
        expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
      };
      notify();
      fetchAccount().catch(() => {});
      resolve(token.value);
    };
    try {
      tc.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (err) {
      pending = null;
      reject(err);
    }
  })).catch((err) => { pending = null; throw err; });
  return pending;
}

function describe(code) {
  if (code === 'popup_closed_by_user') return 'Sign-in window was closed.';
  if (code === 'popup_failed_to_open') return 'The sign-in window was blocked. Allow pop-ups for this site.';
  if (code === 'access_denied') return 'Access to Drive was declined.';
  if (code === 'interaction_required' || code === 'consent_required') {
    return 'Google needs you to sign in again.';
  }
  return `Google sign-in failed (${code}).`;
}

async function fetchAccount() {
  if (!token) return;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token.value}` },
  });
  if (!res.ok) return;                 // userinfo needs a profile scope we may not have
  const body = await res.json();
  account = { email: body.email, name: body.name, picture: body.picture };
  notify();
}

/** Interactive sign-in. Must be called from a click: it opens a popup. */
export function signIn() {
  return request(true);
}

export function signOut() {
  const value = token?.value;
  token = null;
  account = null;
  notify();
  if (value && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(value, () => {});
  }
}

/**
 * A token good for at least the next few minutes, refreshed silently if the
 * one in hand is nearly out. Every Drive request goes through this.
 */
export async function ensureToken() {
  if (token && token.expiresAt - Date.now() > REFRESH_MARGIN_MS) return token.value;
  if (!token) throw new Error('Not signed in to Google Drive.');
  try {
    return await request(false);
  } catch {
    // The silent path failed, so the session is genuinely gone. Say so rather
    // than opening a popup from whatever background task happened to notice.
    token = null;
    notify();
    throw new Error('Your Google session expired. Sign in again.');
  }
}

/** The current token without refreshing — for handing to a worker. */
export function currentToken() {
  return token?.value ?? null;
}
