/**
 * Google Drive configuration.
 *
 * One value has to come from the person running this — a Google Cloud OAuth
 * client ID — because an OAuth client identifies *your* project to Google and
 * cannot be shipped in a repository. Setup is in the README.
 *
 * Scope choice: `drive.readonly`.
 *
 * The narrower `drive.file` scope only reaches files the app itself created or
 * that the user hands over through Google's own Picker widget, which would mean
 * pulling in the Picker script, a second credential (an API key) and Google's
 * file chooser instead of one that matches the rest of this app. `drive.readonly`
 * is a *restricted* scope, so an app that shipped publicly would need Google's
 * verification and a security assessment; an unverified consent screen still
 * works for up to 100 addresses added as test users, which is what this is for.
 * Nothing here ever writes to Drive.
 */

export const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export const isConfigured = Boolean(CLIENT_ID);

/** Where the sign-in script comes from. */
export const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** Drive's own MIME type for a folder — not a media type, so it needs naming. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Anything under this prefix is a Docs/Sheets/Slides file with no bytes to fetch. */
export const NATIVE_PREFIX = 'application/vnd.google-apps.';

export const SETUP_STEPS = [
  'Open console.cloud.google.com and create a project (or pick one you have).',
  'APIs & Services → Library → enable the Google Drive API.',
  'APIs & Services → OAuth consent screen → External, then add your own Google account under Test users.',
  'Credentials → Create credentials → OAuth client ID → Web application.',
  'Add http://localhost:5173 to Authorised JavaScript origins — and, once deployed, the exact '
    + 'deployed origin too (https://your-project.vercel.app, no trailing slash). Google does not '
    + 'accept wildcards, so every origin you use has to be listed.',
  'Copy the client ID into .env at the project root as VITE_GOOGLE_CLIENT_ID=…, then restart the dev server.',
  'Deploying? .env is gitignored, so set the same variable in the Vercel project and redeploy — '
    + 'Vite bakes VITE_* values in at build time, so one added after a build is not in it.',
];
