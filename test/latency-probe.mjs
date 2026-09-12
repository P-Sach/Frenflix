/**
 * What does the browser actually report for audio latency, and does
 * HTMLMediaElement.currentTime already account for it?
 *
 * The controller reads `outputLatency || baseLatency` off a context that has
 * never been resumed. This checks what each of those really is once the
 * context IS running, both bare and with a media element routed through it.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5198;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => vite.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) res(); }));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: !process.argv.includes('--headed'),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/test/bench.html`);
await sleep(500);

const out = await page.evaluate(async () => {
  const r = {};
  const Ctx = window.AudioContext;

  // 1. exactly what the current controller does: read before resuming
  const cold = new Ctx();
  r.coldState = cold.state;
  r.coldOutputLatency = cold.outputLatency;
  r.coldBaseLatency = cold.baseLatency;
  r.whatControllerStores = cold.outputLatency || cold.baseLatency;

  // 2. the same context once it is actually running
  await cold.resume().catch(() => {});
  await new Promise((res) => setTimeout(res, 600));
  r.runningState = cold.state;
  r.runningOutputLatency = cold.outputLatency;
  r.runningBaseLatency = cold.baseLatency;
  r.sampleRate = cold.sampleRate;
  const ts = cold.getOutputTimestamp();
  r.outputTimestampGap = cold.currentTime - ts.contextTime; // render clock ahead of audible
  await cold.close();

  // 3. with a media element routed through the graph
  const el = new Audio('/test/media/audio.webm');
  el.preload = 'auto';
  await new Promise((res) => { el.oncanplay = res; setTimeout(res, 5000); });
  const ctx2 = new Ctx({ latencyHint: 'interactive' });
  await ctx2.resume().catch(() => {});
  const src = ctx2.createMediaElementSource(el);
  src.connect(ctx2.destination);
  await el.play();
  await new Promise((res) => setTimeout(res, 1500));
  r.tappedOutputLatency = ctx2.outputLatency;
  r.tappedBaseLatency = ctx2.baseLatency;
  const ts2 = ctx2.getOutputTimestamp();
  r.tappedRenderVsAudible = ctx2.currentTime - ts2.contextTime;
  // how far the element's own currentTime sits from the graph's render clock
  r.elementVsRenderClock = el.currentTime - (ctx2.currentTime - r.tapStart0 || 0);
  el.pause();
  await ctx2.close();
  return r;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
vite.kill();
