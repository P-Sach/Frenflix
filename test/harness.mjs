/**
 * Drives the bench page in a real Chrome and prints measurements.
 *
 *   node test/harness.mjs                      # every scenario, webm pair
 *   node test/harness.mjs calib steady         # named scenarios only
 *   node test/harness.mjs --codec mp4          # H.264 + AAC pair
 *   node test/harness.mjs --headed
 *
 * `calib` is the important one: it plays a MUXED file and taps the same
 * detector at the video element, so it measures the browser's own A/V sync
 * with the identical instrument. Whatever that reads is the instrument's own
 * bias, and every other number here should be read against it.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const codecIdx = argv.indexOf('--codec');
const codec = codecIdx >= 0 ? argv[codecIdx + 1] : 'webm';
const only = argv.filter((a, i) => !a.startsWith('--') && !(codecIdx >= 0 && i === codecIdx + 1));

const PAIR = codec === 'mp4'
  ? { videoUrl: '/test/media/video.mp4', audioUrl: '/test/media/audio.m4a' }
  : { videoUrl: '/test/media/video.webm', audioUrl: '/test/media/audio.webm' };
const HEAVY = { videoUrl: '/test/media/video-heavy.webm', audioUrl: '/test/media/audio.webm' };
const MUXED = { videoUrl: '/test/media/muxed.webm', audioUrl: null, tap: 'video' };

const PORT = 5199;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (v, d = 1) => (v == null || Number.isNaN(v) ? 'n/a' : (v * 1000).toFixed(d));

async function startVite() {
  const bin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [bin, '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite did not start')), 30000);
    proc.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) { clearTimeout(t); res(); } });
    proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  });
  return proc;
}

const fmt = (s) => (s
  ? `n=${s.n} median ${ms(s.medianSigned)} medianAbs ${ms(s.medianAbs)} p95Abs ${ms(s.p95Abs)} `
    + `max ${ms(s.maxAbs)} range [${ms(s.min)}, ${ms(s.max)}] ms`
  : 'no data');

const results = {};
let browser;

/** A fresh page, so each scenario gets a clean element and a clean audio tap. */
async function fresh(media, { throttleKBs = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console] ${m.text()}`); });
  if (throttleKBs) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 20,
      downloadThroughput: throttleKBs * 1024,
      uploadThroughput: throttleKBs * 1024,
    });
  }
  await page.goto(`http://localhost:${PORT}/test/bench.html`);
  await page.waitForFunction('window.__benchReady === true', null, { timeout: 20000 });
  const info = await page.evaluate((m) => window.__bench.setup(m), media);
  return { page, ctx, info };
}

const want = (name) => only.length === 0 || only.includes(name);

async function main() {
  const vite = await startVite();
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: !headed,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=CalculateNativeWinOcclusion',
      '--force-device-scale-factor=1',
    ],
  });

  // ------------------------------------------------- 0. instrument calibration
  if (want('calib')) {
    console.log('\n=== 0. CALIBRATION: one muxed file, the browser doing its own sync ===');
    const { page, ctx } = await fresh(MUXED);
    await page.evaluate(() => window.__bench.play());
    await sleep(3000);
    await page.evaluate(() => window.__bench.reset());
    await page.evaluate(() => window.__bench.mark('t0'));
    await sleep(12000);
    const r = await page.evaluate(() => window.__bench.report('t0'));
    results.calib = r;
    console.log(`  instrument reads  ${fmt(r.avError)}`);
    console.log('  ^ this is the probe\'s own bias. Subtract it from everything below.');
    await ctx.close();
  }

  // ------------------------- 0b. is the probe itself rate-dependent? Find out.
  if (want('calibrate')) {
    console.log('');
    console.log('=== 0b. CALIBRATION across playback rates (muxed file, browser doing the sync) ===');
    const { page, ctx } = await fresh(MUXED);
    await page.evaluate(() => window.__bench.play());
    await sleep(3000);
    for (const rate of [1, 1.5, 2, 0.75]) {
      await page.evaluate((x) => window.__bench.setRate(x), rate);
      await sleep(3000);
      await page.evaluate(() => window.__bench.reset());
      await page.evaluate(() => window.__bench.mark('t0'));
      await sleep(8000);
      const r = await page.evaluate(() => window.__bench.report('t0'));
      (results.calibrate ||= {})[rate] = r;
      console.log(`  ${String(rate).padStart(4)}x: instrument reads ${String(ms(r.avError?.medianSigned)).padStart(7)} ms `
        + `(p95Abs ${ms(r.avError?.p95Abs)}, n=${r.avError?.n ?? 0})`);
    }
    console.log('  ^ any slope here is the probe, not the player. Subtract before judging.');
    await ctx.close();
  }

  // ------------------------------------------------------------- 1. cold start
  if (want('startup')) {
    console.log('\n=== 1. cold start (small files, fast network) ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.reset());
    await page.evaluate(() => window.__bench.mark('t0'));
    await page.evaluate(() => window.__bench.play());
    await sleep(8000);
    const r = await page.evaluate(() => window.__bench.report('t0'));
    results.startup = r;
    reportStart(r);
    await ctx.close();
  }

  // ------------------------------- 2. cold start when the video has to buffer
  if (want('slowstart')) {
    console.log('\n=== 2. cold start with a heavy video and a thin pipe (the reported bug) ===');
    const { page, ctx } = await fresh(HEAVY, { throttleKBs: 320 });
    await page.evaluate(() => window.__bench.reset());
    await page.evaluate(() => window.__bench.mark('t0'));
    await page.evaluate(() => window.__bench.play());
    await sleep(20000);
    const r = await page.evaluate(() => window.__bench.report('t0'));
    results.slowstart = r;
    reportStart(r);
    console.log('  audio speed, second by second:',
      JSON.stringify(r.audioRateSeries.filter((_, i) => i % 4 === 0).map((x) => x.r)));
    await ctx.close();
  }

  // --------------------------------------------------------- 3. steady state
  if (want('steady')) {
    console.log('\n=== 3. steady state ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(3000);
    await page.evaluate(() => window.__bench.reset());
    await page.evaluate(() => window.__bench.mark('t0'));
    await sleep(15000);
    const r = await page.evaluate(() => window.__bench.report('t0'));
    results.steady = r;
    console.log(`  measured A/V error  ${fmt(r.avError)}   (+ = picture ahead of sound)`);
    printSync(r.readout);
    console.log(`  video rate ${r.readout.videoRate.toFixed(4)}  audio rate ${r.readout.audioRate.toFixed(4)}`);
    console.log('  error over 15 s (ms):', JSON.stringify(r.avSeries.filter((_, i) => i % 4 === 0).map((x) => x.e)));
    await ctx.close();
  }

  // ----------------------------------------------------- 4. the delay control
  if (want('delay')) {
    console.log('\n=== 4. audio delay control: does the picture actually move? ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(3000);
    results.delay = {};
    for (const d of [0, 200, -200, 80, 0]) {
      await page.evaluate((v) => window.__bench.setAudioDelay(v), d);
      await sleep(3000);
      await page.evaluate(() => window.__bench.reset());
      await page.evaluate(() => window.__bench.mark('t0'));
      await sleep(5000);
      const r = await page.evaluate(() => window.__bench.report('t0'));
      results.delay[d] = r;
      const sy = r.readout.sync;
      console.log(`  delay ${String(d).padStart(5)} ms -> measured ${String(ms(r.avError?.medianSigned)).padStart(7)} ms`
        + `   panel: offset ${sy.totalOffsetMs.toFixed(0)} ms (yours ${sy.userOffsetMs.toFixed(0)}, auto ${sy.autoOffsetMs.toFixed(0)})`
        + `  lock ${sy.errorMs.toFixed(1)}+-${sy.p95Ms.toFixed(1)} ms  ${sy.state}`);
    }
    await ctx.close();
  }

  // ------------------------------------------------- 4b. do the modes differ?
  if (want('modes')) {
    console.log('');
    console.log('=== 4b. the three sync modes, measured ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(4000);
    results.modes = {};
    for (const mode of ['auto', 'manual', 'off', 'auto']) {
      await page.evaluate((m) => window.__bench.setSyncMode(m), mode);
      await sleep(4000);
      await page.evaluate(() => window.__bench.reset());
      await page.evaluate(() => window.__bench.mark('t0'));
      await sleep(6000);
      const r = await page.evaluate(() => window.__bench.report('t0'));
      results.modes[mode] = r;
      const s = r.readout.sync;
      console.log(`  ${mode.padEnd(7)} A/V ${String(ms(r.avError?.medianSigned)).padStart(7)} ms  `
        + `auto-comp ${s.autoOffsetMs.toFixed(0)} ms  state ${s.state.padEnd(10)} `
        + `picture trim ${s.trimPercent.toFixed(2)}%`);
    }
    console.log('  auto should sit near zero; manual should sit near the output path,');
    console.log('  because manual deliberately ignores it and leaves it to you.');
    await ctx.close();
  }

  // ------------------------------------------------------------- 5. seeking
  if (want('seek')) {
    console.log('\n=== 5. seek recovery ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(3000);
    results.seek = {};
    for (const target of [20, 5, 40, 41, 12]) {
      await page.evaluate(() => window.__bench.reset());
      await page.evaluate(() => window.__bench.mark('t0'));
      await page.evaluate((t) => window.__bench.seek(t), target);
      await sleep(5000);
      const r = await page.evaluate(() => window.__bench.report('t0'));
      results.seek[target] = r;
      console.log(`  -> ${String(target).padStart(3)}s: picture back +${r.firstFrameAfter}ms, sound back +${r.firstBurstAfter}ms, `
        + `A/V ${ms(r.avError?.medianSigned)} ms, worst ${ms(r.avError?.maxAbs)} ms, stutters ${r.audioStallCount}`);
    }
    await ctx.close();
  }

  // ------------------------------------------------------------ 6. rate change
  if (want('rate')) {
    console.log('\n=== 6. playback rate ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(3000);
    results.rate = {};
    for (const rate of [1.5, 2, 0.75, 1]) {
      await page.evaluate((x) => window.__bench.setRate(x), rate);
      await sleep(3000);
      await page.evaluate(() => window.__bench.reset());
      await page.evaluate(() => window.__bench.mark('t0'));
      await sleep(5000);
      const r = await page.evaluate(() => window.__bench.report('t0'));
      results.rate[rate] = r;
      console.log(`  ${String(rate).padStart(4)}x: A/V ${String(ms(r.avError?.medianSigned)).padStart(7)} ms `
        + `(p95Abs ${ms(r.avError?.p95Abs)}), readout ${ms(r.readout.drift)} ms`);
    }
    await ctx.close();
  }

  // ------------------------------------------------------- 7. transport churn
  if (want('churn')) {
    console.log('\n=== 7. hammering the transport ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(2500);
    await page.evaluate(() => window.__bench.reset());
    await page.evaluate(() => window.__bench.mark('t0'));
    for (let i = 0; i < 8; i += 1) {
      await page.evaluate(() => window.__bench.pause());
      await sleep(150 + i * 60);
      await page.evaluate(() => window.__bench.play());
      await sleep(400);
      await page.evaluate((t) => window.__bench.seek(t), 5 + i * 3);
      await sleep(700);
    }
    await sleep(4000);
    const r = await page.evaluate(() => window.__bench.report('t0'));
    results.churn = r;
    console.log(`  after 8 pause/play/seek cycles: A/V ${ms(r.avError?.medianSigned)} ms, worst ${ms(r.avError?.maxAbs)} ms`);
    console.log(`  still playing: ${!r.readout.paused}, stutters ${r.audioStallCount}`);
    await ctx.close();
  }

  // ------------------------------------------------- 8. instrumented debugging
  if (want('debug')) {
    console.log('');
    console.log('=== 8. traced: what the controller does when the delay jumps ===');
    const { page, ctx } = await fresh(PAIR);
    await page.evaluate(() => window.__bench.play());
    await sleep(4000);
    await page.evaluate(() => window.__bench.startTrace(120));
    for (const d of [-200, 80, 0]) {
      await page.evaluate((v) => window.__bench.setAudioDelay(v), d);
      await sleep(4000);
    }
    const tr = await page.evaluate(() => window.__bench.stopTrace());
    const t0 = tr[0]?.t ?? 0;
    console.log('   ms  phase    seeks  err  filt   vRate   lag  offset  v-a');
    for (const r of tr) {
      console.log(`${String(r.t - t0).padStart(5)}  ${r.phase.padEnd(9)}${String(r.seeks).padStart(4)}`
        + `${String(r.err).padStart(6)}${String(r.filt).padStart(6)}  ${r.vRate.toFixed(4)}`
        + `${String(r.lag).padStart(6)}${String(r.off).padStart(7)}`
        + `${String(Math.round((r.vCt - r.aCt) * 1000)).padStart(6)}`);
    }
    await ctx.close();
  }

  // ----------------------------------------------- 9. why did slowstart die?
  if (want('slowdebug')) {
    console.log('');
    console.log('=== 9. slow pipe, verbose ===');
    const { page, ctx, info } = await fresh(HEAVY, { throttleKBs: 320 });
    console.log('  setup returned:', JSON.stringify(info));
    console.log('  before play:', JSON.stringify(await page.evaluate(() => ({
      ext: window.__bench.el.controller.hasExternalAudio,
      vSrc: window.__bench.video.currentSrc.slice(-30),
      aSrc: window.__bench.audio.currentSrc.slice(-30),
      vRs: window.__bench.video.readyState,
      aRs: window.__bench.audio.readyState,
    }))));
    await page.evaluate(() => window.__bench.startTrace(500));
    await page.evaluate(() => window.__bench.reset());
    await page.evaluate(() => window.__bench.mark('t0'));
    await page.evaluate(() => window.__bench.play());
    await sleep(30000);
    const tr = await page.evaluate(() => window.__bench.stopTrace());
    const t0 = tr[0]?.t ?? 0;
    console.log('   ms  phase       vRs aRs  vCt     aCt    ext clock');
    for (const r of tr.filter((_, i) => i % 2 === 0)) {
      console.log(`${String(r.t - t0).padStart(6)}  ${r.phase.padEnd(12)}${r.vRs}   ${r.aRs}  `
        + `${String(r.vCt).padStart(7)} ${String(r.aCt).padStart(7)}  ${r.ext}  ${r.clock}`);
    }
    const r = await page.evaluate(() => window.__bench.report('t0'));
    results.slowdebug = r;
    reportStart(r);
    console.log('  audio speed:', JSON.stringify(r.audioRateSeries.map((x) => x.r)));
    await ctx.close();
  }

  mkdirSync(join(here, 'out'), { recursive: true });
  writeFileSync(join(here, 'out', `results-${codec}.json`), JSON.stringify(results, null, 1));
  await browser.close();
  vite.kill();
}

function printSync(readout) {
  const s = readout.sync;
  if (!s) return;
  console.log(`  panel says          ${s.state}, clock ${s.clock}${s.clockNote ? ` (${s.clockNote})` : ''}`);
  console.log(`  offset applied      ${s.totalOffsetMs.toFixed(1)} ms = yours ${s.userOffsetMs.toFixed(1)} + auto ${s.autoOffsetMs.toFixed(1)}`);
  console.log(`  lock error          ${s.errorMs.toFixed(1)} ms now, p95 ${s.p95Ms.toFixed(1)} ms, peak ${s.peakMs.toFixed(1)} ms`);
  console.log(`  trim ${s.trimPercent.toFixed(2)}%, learned bias ${s.biasPercent.toFixed(2)}%, seeks ${s.seeks}, output path ${s.latencyMs.toFixed(1)} ms`);
}

function reportStart(r) {
  console.log(`  first picture      +${r.firstFrameAfter} ms after play()`);
  console.log(`  first sound heard  +${r.firstBurstAfter} ms after play()`);
  console.log(`  audio speed        median ${r.audioRate ? r.audioRate.medianSigned.toFixed(3) : 'n/a'}x, `
    + `min ${r.audioRate ? r.audioRate.min.toFixed(3) : 'n/a'}x`);
  console.log(`  audio stutters     ${r.audioStallCount} (intervals under half speed)`);
  const pauses = r.events.filter((e) => e.type === 'pause').length;
  const plays = r.events.filter((e) => e.type === 'play').length;
  console.log(`  play/pause churn   ${plays} play, ${pauses} pause`);
  console.log(`  waiting/stalled    ${r.events.filter((e) => e.type === 'waiting' || e.type === 'stalled').length}`);
  console.log(`  A/V once running   ${ms(r.avError?.medianSigned)} ms`);
  printSync(r.readout);
}

main().catch((e) => { console.error(e); process.exit(1); });
