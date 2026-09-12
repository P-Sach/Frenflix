/**
 * Phase 4 and 5, through the real UI.
 *
 * Multi-track audio, resume, the queue and the captured poster art all touch
 * state that only exists in a browser — IndexedDB, object URLs, a canvas, and
 * a media element that has to keep playing while its audio is replaced. None
 * of it is testable any other way.
 *
 * VP8/Opus throughout, because a CI container's Chromium has no H.264 or AAC.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5197;
const media = join(here, 'media');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = [
  join(media, 'Phase Test (2024) 1080p WEB-DL.webm'),
  join(media, 'Phase.Test.2024.Hindi.DDP5.1.opus'),
  join(media, 'Phase.Test.2024.English.AAC.opus'),
  join(media, 'Phase Test (2024).en.srt'),
  join(media, 'Second Film (2023) 1080p WEB-DL.webm'),
];

const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => vite.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) res(); }));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });

const out = [];
const ok = (label, pass, extra = '') => out.push(`   ${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
const el = () => page.$('frenflix-video');

/**
 * Open a title by name. The library shows the same entry in several rows and
 * their order differs per row, so "the first card" is not a stable way to say
 * which film you mean.
 */
const openTitle = async (re) => {
  // A click on the card's own link, dispatched in the page.
  //
  // Not a page.goto: the library lives in memory, so a real navigation empties
  // it and the watch page then has nothing to play. And not a pointer click
  // either — the same title appears in several rows, some of them
  // horizontally scrolled, so which copy is under the cursor is not something
  // a test should depend on. This exercises the router, which is the point.
  const ok = await page.evaluate((pattern) => {
    const card = [...document.querySelectorAll('article')]
      .find((c) => new RegExp(pattern).test(c.textContent));
    const link = card?.querySelector('a[href^="/watch/"]');
    if (!link) return false;
    link.click();
    return true;
  }, re.source);
  if (!ok) throw new Error(`no card matching ${re}`);
};

await page.goto(`http://localhost:${PORT}/`);
await page.setInputFiles('input[type=file]', FILES);
await page.waitForSelector('article');

out.push('--- 1. two dubs attach to the same title');
const cards = await page.$$eval('article', (a) => a.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
// A title now appears in several rows and again in the grid, so counting
// cards is not counting titles.
const distinct = new Set(await page.$$eval('article a[href^="/watch/"]',
  (as) => as.map((a) => a.getAttribute('href'))));
ok('two titles in the library', distinct.size === 2, `${distinct.size} distinct, ${cards.length} cards`);
const phase = cards.find((c) => /Phase Test/.test(c)) || '';
ok('the card reports both audio tracks', /2 audio tracks/.test(phase), phase.slice(0, 60));
ok('and the subtitle track', /1 subs/.test(phase), phase.slice(0, 70));

out.push('\n--- 2. poster art is captured from the video itself');
await page.waitForFunction(() => {
  const cards = document.querySelectorAll('article').length;
  const drawn = [...document.querySelectorAll('article img')].filter((i) => i.src.startsWith('blob:')).length;
  return cards > 0 && drawn >= cards;
}, null, { timeout: 25000 }).catch(() => {});
const posters = await page.$$eval('article img', (imgs) => imgs.filter((i) => i.src.startsWith('blob:')).length);
ok('cards drew frames grabbed from the files', posters >= 2, `${posters} poster(s)`);
const heroArt = await page.evaluate(() => {
  const hero = document.querySelector('h2')?.closest('div[class*="h-["]');
  const img = hero?.querySelector('img') || document.querySelector('img');
  return Boolean(img && img.src.startsWith('blob:'));
});
ok('the hero banner uses one as a backdrop', heroArt);

out.push('\n--- 3. switching dub track does not disturb the picture');
await openTitle(/Phase Test/);
await page.waitForSelector('frenflix-video');
await page.waitForFunction(() => document.querySelector('frenflix-video')?.duration > 0);
await page.locator('media-play-button').click();
await sleep(2500);
const before = await page.evaluate(() => {
  const e = document.querySelector('frenflix-video');
  return { t: e.currentTime, audioSrc: e.controller.audio.currentSrc, playing: !e.paused };
});
await page.selectOption('select[aria-label="Audio track"]', '1');
await page.waitForFunction(() => !document.querySelector('select[aria-label="Audio track"]').disabled, null, { timeout: 15000 });
await sleep(2000);
const after = await page.evaluate(() => {
  const e = document.querySelector('frenflix-video');
  return {
    t: e.currentTime,
    audioSrc: e.controller.audio.currentSrc,
    videoPaused: e.controller.video.paused,
    playing: !e.paused,
    drift: e.drift,
    videoT: e.controller.video.currentTime,
  };
});
ok('the audio element really changed file', before.audioSrc !== after.audioSrc);
ok('playback carried on across the swap', after.playing && after.t > before.t, `${before.t.toFixed(1)}s → ${after.t.toFixed(1)}s`);
ok('the video never went back to the start', after.videoT > before.t, `video at ${after.videoT.toFixed(1)}s`);
ok('and it re-locked to the new track', Math.abs(after.drift) < 0.12, `drift ${(after.drift * 1000).toFixed(0)} ms`);

out.push('\n--- 4. progress is remembered and offered back');
await page.evaluate(() => { document.querySelector('frenflix-video').currentTime = 40; });
await sleep(6500);                       // the 5s save interval has to tick
// Click the icon, not the element centre: the rail is clipped to 84px while
// each item's box stays as wide as the expanded state, so the centre of the
// box is outside the visible bar. A person clicks the icon.
// Same reasoning as openTitle: exercise the route, not the cursor.
await page.evaluate(() => document.querySelector('aside nav a[href="/"]').click());
await page.waitForSelector('article');
await sleep(1200);
const hasRow = await page.$$eval('h2', (h) => h.some((x) => /Continue watching/.test(x.textContent)));
ok('a "Continue watching" row appeared', hasRow);
const bar = await page.$$eval('article div[style*="width"]', (d) => d.map((x) => x.style.width)).catch(() => []);
ok('the card shows a progress bar', bar.length > 0, bar[0] || '');
const heroResume = await page.evaluate(() => [...document.querySelectorAll('button, a')]
  .some((n) => /Resume/.test(n.textContent)));
ok('and the hero offers Resume', heroResume);

await openTitle(/Phase Test/);
await page.waitForSelector('frenflix-video');
await page.waitForFunction(() => document.querySelector('frenflix-video')?.currentTime > 30, null, { timeout: 15000 })
  .then(() => ok('reopening resumed where it left off', true))
  .catch(async () => ok('reopening resumed where it left off', false,
    `at ${await page.evaluate(() => document.querySelector('frenflix-video')?.currentTime)}`));
const notice = await page.$$eval('span', (s) => s.some((x) => /Resumed from/.test(x.textContent)));
ok('and says so, with a way back to the start', notice);

out.push('\n--- 5. it plays the next title when one ends');
// Reopening starts paused — nothing reaches the end unless we press play,
// which is what made this look like a broken auto-advance the first time.
await page.locator('media-play-button').click();
// And let the resume seek land before seeking again: the restore fires on
// loadedmetadata and would otherwise overwrite this.
await sleep(1500);
const startPath = new URL(page.url()).pathname;
await page.evaluate(() => {
  const e = document.querySelector('frenflix-video');
  e.currentTime = Math.max(0, e.duration - 3);
});
await page.waitForFunction(
  (was) => window.location.pathname !== was,
  startPath,
  { timeout: 40000 },
).catch(() => {});
await sleep(1200);
const title = await page.$eval('h1', (h) => h.textContent).catch(() => '');
ok('it advanced to the other title on its own', /Second Film/.test(title), title);

out.push('\n--- 6. the queue');
// Click the icon, not the element centre: the rail is clipped to 84px while
// each item's box stays as wide as the expanded state, so the centre of the
// box is outside the visible bar. A person clicks the icon.
// Same reasoning as openTitle: exercise the route, not the cursor.
await page.evaluate(() => document.querySelector('aside nav a[href="/"]').click());
await page.waitForSelector('article');
await page.getByRole('button', { name: /Queue all/i }).click();
await sleep(600);
const queued = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('h2')];
  const up = heads.find((h) => /Up next/.test(h.textContent));
  return up ? up.parentElement.textContent.replace(/\s+/g, ' ').trim() : '';
});
ok('queue all filled the queue', /Up next\s*2/.test(queued), queued.slice(0, 40));

// The font comes from Google Fonts, which a sandboxed container cannot reach;
// that is the environment, not the app.
const realErrors = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|fonts\.googleapis/.test(e));
out.push(`\n--- page errors: ${realErrors.length}${errors.length !== realErrors.length ? ' (ignoring blocked web-font fetch)' : ''}`);
for (const e of realErrors.slice(0, 5)) out.push(`   ${e}`);

console.log(out.join('\n'));
await browser.close();
vite.kill();
