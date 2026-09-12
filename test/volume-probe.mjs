/**
 * If the controller routes the audio element through Web Audio to get a real
 * clock, does the element's own `volume` still apply? Chrome's behaviour here
 * decides whether a GainNode is needed to keep the volume control working.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5197;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => vite.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) res(); }));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/test/bench.html`);
await sleep(300);

const out = await page.evaluate(async () => {
  const el = new Audio('/test/media/audio.webm');
  el.preload = 'auto';
  await new Promise((res) => { el.oncanplay = res; setTimeout(res, 6000); });
  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const src = ctx.createMediaElementSource(el);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  src.connect(an);
  an.connect(ctx.destination);
  const buf = new Float32Array(an.fftSize);
  const peak = async (ms) => {
    let mx = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i += 1) mx = Math.max(mx, Math.abs(buf[i]));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return mx;
  };
  await el.play();
  await new Promise((r) => setTimeout(r, 800));
  const full = await peak(900);
  el.volume = 0.25;
  await new Promise((r) => setTimeout(r, 300));
  const quarter = await peak(900);
  el.muted = true;
  await new Promise((r) => setTimeout(r, 300));
  const muted = await peak(900);
  el.pause();
  await ctx.close();
  return { full, quarter, muted, ratio: quarter / (full || 1) };
});

console.log(JSON.stringify(out, null, 2));
console.log(out.ratio < 0.5
  ? '=> element volume DOES apply before the tap; no GainNode needed.'
  : '=> element volume does NOT apply through the tap; a GainNode is required.');
await browser.close();
vite.kill();
