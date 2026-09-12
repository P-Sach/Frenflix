/**
 * The picture that is asked to play and does not.
 *
 * Every readiness check in the controller asks an element whether it *could*
 * play. None of them prove it *did*. Reported from a 108 MB 1080p H.264 file
 * on Windows: two seconds of sound over a frozen first frame, then the picture
 * arriving late — and since the correction loop only notices once the gap is
 * seconds wide, closing it meant seeking a decoder that was already
 * struggling.
 *
 * The container's Chromium starts its VP9 decoder promptly, so the failure is
 * induced rather than waited for: the video element's own `play()` is delayed
 * two seconds, which is exactly the shape of the fault — asked to play,
 * nothing moves, sound running.
 *
 *   node test/slow-decoder-harness.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5210;
const PAIR = { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio.webm' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How far the sound may ever get ahead of the picture. Perceptibility is ~45 ms. */
const MAX_GAP_MS = 400;

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

async function run(browser, { label, delayMs }) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/test/bench.html`);
  await page.waitForFunction('window.__benchReady === true', null, { timeout: 20000 });
  await page.evaluate((m) => window.__bench.setup(m), PAIR);

  if (delayMs) {
    await page.evaluate((ms) => {
      const v = window.__bench.el.controller.video;
      const real = v.play.bind(v);
      v.play = () => new Promise((resolve) => {
        setTimeout(() => { real().then(resolve, resolve); }, ms);
      });
    }, delayMs);
  }

  // Sample the gap between the two positions every 50 ms from the press.
  await page.evaluate(() => {
    const c = window.__bench.el.controller;
    window.__gaps = [];
    window.__watch = setInterval(() => {
      window.__gaps.push({
        t: Math.round(performance.now()),
        v: Number(c.video.currentTime.toFixed(3)),
        a: Number(c.audio.currentTime.toFixed(3)),
        aPaused: c.audio.paused,
        phase: c._phase,
      });
    }, 50);
  });
  await page.evaluate(() => window.__bench.play());
  await sleep(7000);
  const got = await page.evaluate(() => {
    clearInterval(window.__watch);
    return { gaps: window.__gaps, status: window.__bench.el.syncStatus, t: window.__bench.el.currentTime };
  });

  // The gap only means anything while the sound is actually running.
  const live = got.gaps.filter((g) => !g.aPaused && g.a > 0.05);
  const worst = live.reduce((m, g) => Math.max(m, (g.a - g.v) * 1000), 0);
  const phases = [...new Set(got.gaps.map((g) => g.phase))].join(' ');

  console.log(`\n=== ${label} ===`);
  console.log(`  phases seen: ${phases}`);
  console.log(`  worst the sound got ahead of the picture: ${worst.toFixed(0)} ms`);
  console.log(`  starts abandoned and retried: ${got.status.startAborts}`);
  console.log(`  playing at ${got.t.toFixed(2)}s after 7 s, error ${got.status.errorMs.toFixed(0)} ms`);

  check(worst <= MAX_GAP_MS, `${label}: the sound never runs away from the picture`,
    `worst ${worst.toFixed(0)} ms (bar ${MAX_GAP_MS})`);
  check(got.t > 1.5, `${label}: and it is playing by the end`, `at ${got.t.toFixed(2)}s`);
  check(Math.abs(got.status.errorMs) < 60, `${label}: in sync once running`,
    `${got.status.errorMs.toFixed(0)} ms`);

  await ctx.close();
  return { worst, aborts: got.status.startAborts };
}

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const healthy = await run(browser, { label: 'an ordinary start', delayMs: 0 });
    check(healthy.aborts === 0, 'a healthy start is never interfered with',
      `${healthy.aborts} abandoned`);
    await run(browser, { label: 'a picture that takes two seconds to move', delayMs: 2000 });
  } finally {
    await browser.close();
    vite.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
