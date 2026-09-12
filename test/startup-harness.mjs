/**
 * The first second.
 *
 * Every other bench here reports the steady state, and the steady state was
 * never the complaint: the complaint was that the opening of a film is out of
 * sync and then settles. That is a different measurement — a handful of
 * samples in the first second, not a p95 over thirty — so it gets its own
 * driver.
 *
 * What it measures is the real thing, not the controller's opinion of it: the
 * bench page hears audible bursts through an AudioWorklet and pairs each one
 * against the video frame actually on screen at the instant it was heard
 * (see test/bench.js). Positive error = picture ahead of sound.
 *
 *   node test/startup-harness.mjs
 *   node test/startup-harness.mjs --headed
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const headed = process.argv.includes('--headed');
const PORT = 5207;
const PAIR = { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio.webm' };
/** 3.4 Mbit/s of video down a 2.5 Mbit/s pipe: a stream that cannot keep up. */
const HEAVY = { videoUrl: '/test/media/video-heavy.webm', audioUrl: '/test/media/audio.webm' };
const THROTTLE_KBS = 320;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bursts are 250ms apart, so this is the window the viewer notices. */
const WINDOW_MS = 2000;
/**
 * Bars, and where they come from.
 *
 * These are set from the measured difference between the two cases below, not
 * picked for comfort. Starting mid-file was always correct — the picture can
 * be placed behind the sound by seeking — so it is the control, and starting
 * at the top of the file has to match it.
 *
 * With the opening uncorrected, this harness reads the audible error at
 * +31 ms a third of a second in and still +14 ms a second in, decaying over
 * roughly 1.3 s, and the controller's own per-frame figure sits at +28 to
 * +46 ms for the first 430 ms. Corrected, both read flat from the first frame.
 * Judged on the MEDIAN absolute error, not the worst. A shared-CPU headless
 * container drops the odd frame, which puts a lone 15-30 ms spike in an
 * otherwise flat series — one frame period at 30 fps. The bug being guarded
 * against is nothing like that: it is a sustained offset that decays, so every
 * early sample carries it and the median moves. The worst is printed too,
 * because it is worth seeing, but it is not what passes or fails.
 */
const AUDIBLE_BAR_MS = 12;
const FRAME_BAR_MS = 20;
/**
 * Stop/start churn on a pipe that cannot keep up. Measured on this container:
 * 32 play / 30 pause without the buffer hysteresis, 8-10 with it. The bar sits
 * in that gap with room for variance.
 */
const CHURN_BAR = 12;
/** Looser once running: this window is not what the bug affects, and the
 *  container's own jitter lands a few milliseconds off the bar above. */
const LATE_BAR_MS = 18;
/** The probe's first pairing straddles the edge of the frame series and is
 *  wide in every run, corrected or not. Judged from the second one on. */
const AUDIBLE_FROM_MS = 500;

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

async function run(browser, { from = 0, label, media = PAIR, throttleKBs = 0 }) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  if (throttleKBs) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: throttleKBs * 1024,
      uploadThroughput: throttleKBs * 1024,
    });
  }
  await page.goto(`http://localhost:${PORT}/test/bench.html`);
  await page.waitForFunction('window.__benchReady === true', null, { timeout: 20000 });
  await page.evaluate((m) => window.__bench.setup(m), media);
  if (from > 0) {
    await page.evaluate((t) => window.__bench.seek(t), from);
    await sleep(600);
  }
  await page.evaluate(() => window.__bench.reset());
  await page.evaluate(() => window.__bench.mark('t0'));
  await page.evaluate(() => window.__bench.startTrace(16));
  await page.evaluate(() => window.__bench.play());
  await sleep(throttleKBs ? 20000 : WINDOW_MS + 1500);
  const r = await page.evaluate(() => window.__bench.report('t0'));
  const trace = await page.evaluate(() => window.__bench.stopTrace());

  const early = r.avSeries.filter((s) => s.w <= WINDOW_MS);
  const late = r.avSeries.filter((s) => s.w > WINDOW_MS);
  const judged = r.avSeries.filter((s) => s.w >= AUDIBLE_FROM_MS && s.w <= WINDOW_MS);
  const medianAbs = (xs) => {
    if (xs.length === 0) return 0;
    const a = xs.map((s) => Math.abs(s.e)).sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)];
  };
  const worstOf = (xs) => xs.reduce((m, s) => Math.max(m, Math.abs(s.e)), 0);
  const typical = medianAbs(judged);
  const worst = worstOf(judged);
  const lateTypical = medianAbs(late);
  const lateWorst = worstOf(late);

  console.log(`\n=== ${label} ===`);
  console.log(`  first picture   +${r.firstFrameAfter} ms, first sound +${r.firstBurstAfter} ms`);
  console.log(`  output path     ${r.readout.sync.latencyMs.toFixed(1)} ms (${r.readout.sync.clock})`);
  console.log(`  offset applied  ${r.readout.sync.totalOffsetMs.toFixed(1)} ms`);
  console.log(`  error, first ${WINDOW_MS} ms: ${early.map((s) => `${s.w}ms:${s.e > 0 ? '+' : ''}${s.e}`).join('  ') || 'no samples'}`);
  console.log(`  error, after:            ${late.map((s) => `${s.w}ms:${s.e > 0 ? '+' : ''}${s.e}`).join('  ') || 'no samples'}`);
  // The acoustic probe cannot hear anything before its first burst, ~300ms
  // in, and the transient being hunted is over by then. The controller's own
  // per-frame reading covers that gap: same quantity, and the probe above
  // agrees with it to about 5 ms once both can see.
  const opening = trace.filter((t) => t.t - trace[0].t <= 700 && t.ext);
  console.log(`  per-frame error, opening 700 ms: ${opening.map((t) => `${t.t - trace[0].t}:${t.err}`).join(' ')}`);
  const held = trace.filter((t) => t.vCt === 0 && t.aCt > 0).length;
  console.log(`  samples with the picture held at frame one: ${held}`);

  // The first couple of trace samples are taken before any frame has been
  // presented, so they read a flat zero that means "nothing measured yet".
  const frames = opening.filter((t) => t.t - trace[0].t > 30);
  const frameErrs = frames.map((t) => Math.abs(t.err)).sort((p, q) => p - q);
  const frameTypical = frameErrs.length ? frameErrs[Math.floor(frameErrs.length / 2)] : 0;
  const frameWorst = frameErrs.length ? frameErrs[frameErrs.length - 1] : 0;

  // Stop/start churn: the readiness gate thrashing is what the viewer hears as
  // a broken record, and it is invisible in an A/V error figure.
  const plays = r.events.filter((e) => e.type === 'play' && e.who === 'audio').length;
  const pauses = r.events.filter((e) => e.type === 'pause' && e.who === 'audio').length;
  const audioRate = r.audioRate ? r.audioRate.medianSigned : 0;
  console.log(`  audio stop/start: ${plays} play, ${pauses} pause · median audio speed ${audioRate.toFixed(3)}x · ${r.audioStallCount} intervals under half speed`);

  if (throttleKBs) {
    // Baseline on this container with the hysteresis removed: 32 play,
    // 30 pause, 9 sub-half-speed intervals. With it: 8-10 play, 6-10 pause.
    check(plays <= CHURN_BAR && pauses <= CHURN_BAR, `${label}: one clean hold, not a stutter`,
      `${plays} play / ${pauses} pause (bar ${CHURN_BAR} each)`);
    check(Math.abs(audioRate - 1) < 0.02, `${label}: the sound runs at full speed between holds`,
      `median ${audioRate.toFixed(3)}x`);
    await ctx.close();
    return { plays, pauses };
  }

  check(early.length >= 5, `${label}: the probe heard the opening`, `${early.length} samples`);
  check(typical <= AUDIBLE_BAR_MS, `${label}: the opening is audibly in sync`,
    `median ${typical.toFixed(1)} ms from ${AUDIBLE_FROM_MS} ms on, worst ${worst.toFixed(1)} (bar ${AUDIBLE_BAR_MS})`);
  check(frameTypical <= FRAME_BAR_MS, `${label}: and in sync from the very first frames`,
    `median ${frameTypical} ms in the opening 700 ms, worst ${frameWorst} (bar ${FRAME_BAR_MS})`);
  check(lateTypical <= LATE_BAR_MS, `${label}: and stays in sync`,
    `median ${lateTypical.toFixed(1)} ms after, worst ${lateWorst.toFixed(1)}`);

  await ctx.close();
  return { early, late, worst };
}

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: !headed,
    args: ['--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1'],
  });
  try {
    // From the top of the file: the case that cannot be fixed by seeking,
    // because there is no frame before the first one.
    await run(browser, { from: 0, label: 'start from the beginning' });
    // From the middle: the pre-position can do its work, so this one was
    // always fine and is here to prove the change did not break it.
    await run(browser, { from: 4, label: 'start from four seconds in' });
    // And a pipe that genuinely cannot keep up, which is where the readiness
    // gate used to thrash: stop, start, stop, start, several times a second.
    await run(browser, {
      label: 'a stream that cannot keep up', media: HEAVY, throttleKBs: THROTTLE_KBS,
    });
  } finally {
    await browser.close();
    vite.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
