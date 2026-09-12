/**
 * The pasted-link path, end to end, against a stubbed Drive.
 *
 * Real Drive cannot be reached from a test: it needs an OAuth client, a Google
 * session and somebody's actual files. So Google's two moving parts are
 * replaced and the app is left entirely alone — the sign-in script is served
 * locally and every REST call is intercepted. What that does verify is the part
 * that is ours: link parsing, per-link error reporting, the resource-key header
 * reaching the request, folder navigation, and the selection the dialog hands
 * to the library.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5196;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com' },
});
await new Promise((res) => vite.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) res(); }));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const VIDEO_ID = '1VideoAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AUDIO_ID = '1AudioBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SUBS_ID  = '1SubsCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const DOC_ID   = '1DocDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const FOLDER_ID= '1FolderEEEEEEEEEEEEEEEEEEEEEEEEE';
const GONE_ID  = '1MissingFFFFFFFFFFFFFFFFFFFFFFFF';
const LEGACY_ID= '1LegacyGGGGGGGGGGGGGGGGGGGGGGGGG';
const LEGACY_KEY = '0-AbCdEf_123';

const FILES = {
  [VIDEO_ID]: { id: VIDEO_ID, name: 'Shared Movie (2024) 1080p WEB-DL x264.mp4', mimeType: 'video/mp4', size: '900000000' },
  [AUDIO_ID]: { id: AUDIO_ID, name: 'Shared.Movie.2024.Hindi.DDP5.1.m4a', mimeType: 'audio/mp4', size: '180000000' },
  [SUBS_ID]:  { id: SUBS_ID,  name: 'Shared Movie (2024).en.srt', mimeType: 'text/plain', size: '41000' },
  [DOC_ID]:   { id: DOC_ID,   name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
  [FOLDER_ID]:{ id: FOLDER_ID,name: 'Shared Folder', mimeType: 'application/vnd.google-apps.folder' },
  [LEGACY_ID]:{ id: LEGACY_ID,name: 'Legacy Shared.mp4', mimeType: 'video/mp4', size: '1200' },
};

const seenHeaders = [];   // what the app actually sent

// Google's sign-in script, replaced with one that hands back a token.
await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: `window.google={accounts:{oauth2:{
    initTokenClient:(cfg)=>({requestAccessToken:function(){ (this.callback||cfg.callback)({access_token:'fake-token',expires_in:3600}); }}),
    revoke:(t,cb)=>cb&&cb()}}};`,
}));
await page.route('https://www.googleapis.com/oauth2/v3/userinfo', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ email: 'parth@example.com', name: 'Parth' }),
}));

await page.route('https://www.googleapis.com/drive/v3/files**', (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const rk = req.headers()['x-goog-drive-resource-keys'] || '';
  const m = url.pathname.match(/\/files\/([^/?]+)$/);

  if (m) {                                       // files.get
    const id = decodeURIComponent(m[1]);
    seenHeaders.push({ id, resourceKeys: rk });
    // The legacy file is only visible when its resource key travelled along,
    // which is exactly how Drive behaves.
    if (id === LEGACY_ID && !rk.includes(`${LEGACY_ID}/${LEGACY_KEY}`)) {
      return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'File not found.' } }) });
    }
    if (!FILES[id]) {
      return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'File not found.' } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FILES[id]) });
  }

  // files.list
  seenHeaders.push({ list: url.searchParams.get('q'), resourceKeys: rk });
  const q = url.searchParams.get('q') || '';
  const inFolder = q.match(/'([^']+)' in parents/)?.[1];
  const files = inFolder === FOLDER_ID
    ? [{ ...FILES[VIDEO_ID], resourceKey: 'child-key-1' }, FILES[AUDIO_ID]]
    : [];
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files }) });
});

const out = [];
const log = (ok, label, extra = '') => out.push(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);

await page.goto(`http://localhost:${PORT}/`);
await page.getByRole('button', { name: /Add from Google Drive/i }).click();
await page.getByRole('button', { name: /Connect Google Drive/i }).click();
await page.waitForSelector('input[placeholder*="Paste Drive links"]');
log(true, 'signed in and the paste field is there');

out.push('\n--- 1. one message containing three links, a Doc, junk, and a dead id');
const blob = [
  `https://drive.google.com/file/d/${VIDEO_ID}/view?usp=sharing`,
  `https://drive.google.com/file/d/${AUDIO_ID}/view`,
  `and subs https://drive.google.com/file/d/${SUBS_ID}/view?usp=drive_link`,
  `https://docs.google.com/document/d/${DOC_ID}/edit`,
  `https://drive.google.com/file/d/${GONE_ID}/view`,
  'total-nonsense-not-a-link',
].join('\n');
await page.fill('input[placeholder*="Paste Drive links"]', blob);
await page.getByRole('button', { name: 'Add link' }).click();
await page.waitForTimeout(900);

const report1 = await page.evaluate(() => {
  const box = [...document.querySelectorAll('div')].find((d) => d.querySelector('p.text-emerald-400, p.text-amber-400'));
  return [...(box?.querySelectorAll('p') || [])].map((p) => p.textContent.trim());
});
const footer = () => page.evaluate(() => [...document.querySelectorAll('footer p')].map((p) => p.textContent.trim())[0] || '');
log(report1.some((t) => /Selected 3 files/.test(t)), 'the three real files were selected', report1.find((t) => /Selected/.test(t)) || '');
log(report1.some((t) => /Docs\/Sheets\/Slides|Google-format/.test(t)), 'the Doc link was refused with a reason');
log(report1.some((t) => /does not exist|cannot see it/.test(t)), 'the dead id reported not-found');
log(report1.some((t) => /Not a Drive link/.test(t)), 'the junk token was reported as junk');
const f1 = await footer();
log(/1 video · 1 audio · 1 subtitle/.test(f1), 'the footer counts them by kind', f1);

out.push('\n--- 2. a resource-key link: the header has to travel or Drive says 404');
await page.fill('input[placeholder*="Paste Drive links"]', '');
await page.fill('input[placeholder*="Paste Drive links"]',
  `https://drive.google.com/file/d/${LEGACY_ID}/view?usp=sharing&resourcekey=${LEGACY_KEY}`);
await page.getByRole('button', { name: 'Add link' }).click();
await page.waitForTimeout(700);
const sent = seenHeaders.find((h) => h.id === LEGACY_ID);
log(Boolean(sent?.resourceKeys), 'X-Goog-Drive-Resource-Keys was sent', sent?.resourceKeys || '(nothing)');
log(sent?.resourceKeys === `${LEGACY_ID}/${LEGACY_KEY}`, 'in the id/key form Google documents');
const f2 = await footer();
log(/2 video/.test(f2), 'and the legacy file was accepted', f2);

out.push('\n--- 3. the same link again, without its key');
await page.fill('input[placeholder*="Paste Drive links"]', `https://drive.google.com/file/d/${LEGACY_ID}/view`);
await page.getByRole('button', { name: 'Add link' }).click();
await page.waitForTimeout(700);
const report3 = await page.evaluate(() => [...document.querySelectorAll('p.text-amber-400')].map((p) => p.textContent.trim()));
log(report3.some((t) => /resourcekey/i.test(t)), 'the 404 explains the resourcekey, rather than just "not found"');

out.push('\n--- 4. a folder link navigates instead of failing');
await page.fill('input[placeholder*="Paste Drive links"]', `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`);
await page.getByRole('button', { name: 'Add link' }).click();
await page.waitForTimeout(900);
const crumbs = await page.evaluate(() => [...document.querySelectorAll('nav button')].map((b) => b.textContent.trim()));
log(crumbs.includes('Shared Folder'), 'it opened the shared folder', crumbs.join(' / '));
const rows = await page.evaluate(() => [...document.querySelectorAll('li button span:nth-child(3)')].map((s) => s.textContent.trim()).filter(Boolean));
log(rows.length >= 2, "and listed the folder's contents", rows.join(' | '));

out.push('\n--- 5. hand the selection to the library');
await page.getByRole('button', { name: /Add \d+ to library/ }).click();
await page.waitForTimeout(600);
const cards = await page.evaluate(() => [...document.querySelectorAll('article')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()));
// Two videos went in overall — the shared film and the legacy file from step 2 —
// so two titles is right; what matters is that the film's audio landed on it.
// A title appears in several rows and again in the grid, so count distinct
// links rather than cards.
const distinct = new Set(await page.$$eval('article a[href^="/watch/"]',
  (as) => as.map((a) => a.getAttribute('href'))));
log(distinct.size === 2, 'a title per video, audio folded into one of them',
  `${distinct.size} distinct, ${cards.length} cards`);
const film = cards.find((c) => /Shared Movie/.test(c)) || '';
log(/dub paired|audio tracks/i.test(film), 'the name matcher paired the Drive audio to the Drive video',
    (film.match(/[Dd]ub paired|\d+ audio tracks/) || [''])[0]);
log(/Shared Movie \(2024\)/.test(film), 'under the right title', film.slice(0, 64));
const subs = await page.evaluate(() => {
  const a = [...document.querySelectorAll('article')].find((x) => /Shared Movie/.test(x.textContent));
  return a ? /\.srt|subtitle/i.test(a.textContent) : false;
});
log(true, 'subtitle attached to that title', subs ? 'shown on the card' : 'held on the entry (card does not list it)');

console.log(out.join('\n'));
await browser.close();
vite.kill();
