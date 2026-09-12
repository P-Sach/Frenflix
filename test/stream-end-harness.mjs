/**
 * What happens when the two streams do not end together.
 *
 * A separately sourced dub is very often a second or two shorter than the film
 * it belongs to. The pair used to end on whichever stream ran out first, so a
 * 6:13 video stopped at 6:11: the last of the picture was never shown, and
 * because the sound is the master clock, the time display froze there too.
 *
 * The sound running out is a demotion, not an ending — the picture plays on to
 * its own end in silence and the clock falls back to it.
 *
 *   node test/stream-end-harness.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5209;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 70 s of picture, 68 s of sound. */
const SHORT_DUB = { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio-short.webm' };
/** Both 70 s, to prove the ordinary end still ends. */
const MATCHED = { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio.webm' };

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
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`   PASS  ${label}  ${detail}`); }
  else { fail += 1; console.log(`   FAIL  ${label}  ${detail}`); }
};

async function open(browser, media, seekTo) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/test/bench.html`);
  await page.waitForFunction('window.__benchReady === true', null, { timeout: 20000 });
  await page.evaluate((m) => window.__bench.setup(m), media);
  await page.evaluate(() => {
    window.__ended = 0;
    window.__bench.el.addEventListener('ended', () => { window.__ended += 1; });
  });
  await page.evaluate((t) => window.__bench.seek(t), seekTo);
  await sleep(700);
  await page.evaluate(() => window.__bench.play());
  return { page, ctx };
}

const read = (page) => page.evaluate(() => {
  const el = window.__bench.el;
  return {
    t: el.currentTime,
    duration: el.duration,
    paused: el.paused,
    ended: window.__ended,
    videoT: el.controller.video.currentTime,
    audioT: el.controller.audio.currentTime,
    exhausted: el.syncStatus.audioExhausted,
    phase: el.syncStatus.phase,
  };
});

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    console.log('\n=== a dub two seconds shorter than the film ===');
    const a = await open(browser, SHORT_DUB, 65);
    const early = await read(a.page);
    check(Math.abs(early.duration - 70) < 0.2, 'the reported length is the picture\'s, not the sound\'s',
      `duration ${early.duration?.toFixed(2)}s`);

    // Cross the point where the sound runs out (68 s).
    await sleep(4500);
    const mid = await read(a.page);
    console.log(`  after the sound ran out: clock ${mid.t.toFixed(2)}s, picture ${mid.videoT.toFixed(2)}s, sound ${mid.audioT.toFixed(2)}s, phase ${mid.phase}`);
    check(mid.exhausted === true, 'the controller knows the sound ran out first',
      `audioExhausted=${mid.exhausted}`);
    check(mid.ended === 0, 'it did not call that the end of the film', `${mid.ended} ended events`);
    check(mid.videoT > 68.3, 'the picture carried on past where the sound stopped',
      `picture at ${mid.videoT.toFixed(2)}s`);
    check(mid.t > 68.3, 'and the clock followed the picture rather than freezing',
      `clock at ${mid.t.toFixed(2)}s`);

    // Now let the picture reach its own end.
    await sleep(3000);
    const done = await read(a.page);
    check(done.ended === 1, 'the film ends once, at the end of the picture',
      `${done.ended} ended events, picture stopped at ${done.videoT.toFixed(2)}s`);
    check(done.videoT > 69.5, 'having played to the last of it', `${done.videoT.toFixed(2)}s of 70`);
    await a.ctx.close();

    console.log('\n=== streams that do end together ===');
    const b = await open(browser, MATCHED, 67);
    await sleep(5000);
    const m = await read(b.page);
    check(m.ended === 1, 'still ends exactly once', `${m.ended} ended events`);
    check(m.exhausted === false, 'and never reports the sound as having run out early',
      `audioExhausted=${m.exhausted}`);
    await b.ctx.close();
  } finally {
    await browser.close();
    vite.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
