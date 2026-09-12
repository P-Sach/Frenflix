/**
 * The play press made before there is anything to play.
 *
 * A Google Drive title cannot be streamed — Drive will not serve ranged reads
 * to a browser — so it is copied to the device in full before the player gets
 * a URL, which on a film is minutes. A viewer who presses play during that
 * wait meant it, and used to get nothing: the controller clears its play
 * intent whenever the source changes, so the press was discarded the instant
 * the download finished. Worse, the controls layer had already been told
 * playback was starting and was never told otherwise, so it sat on its
 * loading spinner for ever — the "infinite loading" this checks against.
 *
 *   node test/pending-play-harness.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5208;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite() {
  const bin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [bin, '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite did not start')), 30000);
    proc.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) { clearTimeout(t); res(); } });
  });
  return proc;
}

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  if (ok) { pass += 1; console.log(`   PASS  ${label}  ${detail}`); }
  else { fail += 1; console.log(`   FAIL  ${label}  ${detail}`); }
};

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/test/bench.html`);
  await page.waitForFunction('window.__benchReady === true', null, { timeout: 20000 });

  // Count what the controls layer would see, so "it sat on a spinner" is
  // checked rather than assumed: media-chrome clears its spinner on `playing`
  // and believes playback stopped on `pause`.
  await page.evaluate(() => {
    const el = window.__bench.el;
    window.__seen = [];
    for (const type of ['play', 'pause', 'playing', 'waiting', 'loadstart']) {
      el.addEventListener(type, () => window.__seen.push(type));
    }
  });

  console.log('\n=== play pressed while the file is still being copied ===');

  // The press. No source has ever been assigned — exactly the state the watch
  // page is in while a Drive title downloads.
  await page.evaluate(() => window.__bench.el.play().catch(() => {}));
  await sleep(600);
  const during = await page.evaluate(() => ({
    paused: window.__bench.el.paused,
    phase: window.__bench.el.controller._phase,
    videoPaused: window.__bench.el.controller.video.paused,
    seen: [...window.__seen],
  }));
  check(during.paused === false, 'the press is remembered, not dropped',
    `paused=${during.paused}, phase=${during.phase}`);
  check(during.phase === 'no-source', 'the controller knows why it is not playing',
    `phase=${during.phase}`);

  // The download finishes and the URL finally arrives.
  await page.evaluate(() => {
    window.__bench.el.sources = { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio.webm' };
  });
  await sleep(2500);
  const after = await page.evaluate(() => ({
    paused: window.__bench.el.paused,
    videoPaused: window.__bench.el.controller.video.paused,
    audioPaused: window.__bench.el.controller.audio.paused,
    t: window.__bench.el.currentTime,
    seen: [...window.__seen],
  }));
  console.log(`  events the controls layer saw: ${after.seen.join(' ')}`);
  check(after.paused === false && !after.videoPaused && !after.audioPaused,
    'it starts playing on its own when the source lands',
    `paused=${after.paused} video=${after.videoPaused} audio=${after.audioPaused}`);
  check(after.t > 0.3, 'and is actually advancing', `at ${after.t.toFixed(2)}s`);
  check(after.seen.includes('playing'),
    'the controls layer is told playback began, so the spinner clears',
    `saw ${after.seen.filter((e) => e === 'playing').length} playing event(s)`);

  console.log('\n=== a source arriving with no press pending ===');
  const page2 = await browser.newPage();
  await page2.goto(`http://localhost:${PORT}/test/bench.html`);
  await page2.waitForFunction('window.__benchReady === true', null, { timeout: 20000 });
  await page2.evaluate(() => {
    window.__bench.el.sources = { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio.webm' };
  });
  await sleep(800);
  const idle = await page2.evaluate(() => ({
    paused: window.__bench.el.paused,
    videoPaused: window.__bench.el.controller.video.paused,
  }));
  check(idle.paused === true && idle.videoPaused === true,
    'nothing starts by itself', `paused=${idle.paused}`);

  await browser.close();
  vite.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
