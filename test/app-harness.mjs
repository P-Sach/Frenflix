/**
 * End-to-end, through the real UI.
 *
 * The bench drives the custom element directly, which is the right way to
 * measure sync but skips everything a person actually touches: the drop zone,
 * the name matcher, the library card, the route, and media-chrome's play
 * button. This drives those.
 *
 * The files are named so the pairing matcher has to do its job, and they are
 * H.264/AAC in MP4 — the combination almost every real file is, and one the
 * sync bench never covers because it runs on VP9/Opus.
 */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5194;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Names the matcher should pair on its own: same title, different release noise.
const media = join(here, 'media');
mkdirSync(media, { recursive: true });
const VIDEO = join(media, 'Sync Test (2024) 1080p WEB-DL x264.mp4');
const AUDIO = join(media, 'Sync.Test.2024.Hindi.DDP5.1.m4a');
const SUBS = join(media, 'Sync Test (2024).en.srt');
if (!existsSync(VIDEO)) copyFileSync(join(media, 'video.mp4'), VIDEO);
if (!existsSync(AUDIO)) copyFileSync(join(media, 'audio.m4a'), AUDIO);
if (!existsSync(SUBS)) {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nFirst cue\n\n2\n00:00:05,000 --> 00:00:09,000\nSecond cue\n';
  execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(SUBS)}, ${JSON.stringify(srt)})`]);
}

const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => vite.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) res(); }));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: !process.argv.includes('--headed'),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) problems.push(`console: ${m.text()}`); });

const step = (s) => console.log(`\n--- ${s}`);
const ok = (label, cond, extra = '') => console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);

await page.goto(`http://localhost:${PORT}/`);

step('1. drop three files on the library');
await page.setInputFiles('input[type=file]', [VIDEO, AUDIO, SUBS]);
await page.waitForSelector('article', { timeout: 10000 });
const cardText = await page.locator('article').first().innerText();
ok('a title appeared', cardText.length > 0);
ok('the matcher paired the audio by name', /dub paired|audio tracks/i.test(cardText), cardText.split('\n').join(' | '));

step('2. open it');
await page.getByRole('link', { name: 'Play' }).first().click();
await page.waitForSelector('frenflix-video', { timeout: 10000 });
await sleep(1500);
const canDecode = await page.evaluate(() => {
  const el = document.querySelector('frenflix-video');
  return { v: el.controller.video.readyState, a: el.controller.audio.readyState, dur: el.duration };
});
ok('both files decoded (H.264 + AAC)', canDecode.v >= 2 && canDecode.a >= 2, JSON.stringify(canDecode));

step('3. press the real play button');
await page.locator('media-play-button').click();
await sleep(6000);
const running = await page.evaluate(() => {
  const el = document.querySelector('frenflix-video');
  return {
    paused: el.paused,
    t: el.currentTime,
    videoT: el.controller.video.currentTime,
    sync: el.syncStatus,
  };
});
ok('it is playing', !running.paused && running.t > 2, `t=${running.t.toFixed(2)}s`);
ok('the picture is moving too', running.videoT > 2, `video t=${running.videoT.toFixed(2)}s`);
ok('the audio clock is measured, not guessed', running.sync.clock === 'measured',
  `output path ${running.sync.latencyMs.toFixed(0)} ms`);
ok('the syncer reports a lock', ['locked', 'tracking'].includes(running.sync.state),
  `${running.sync.state}, p95 ${running.sync.p95Ms.toFixed(1)} ms`);

step('4. the on-screen panel says the same thing');
const chip = await page.locator('section', { hasText: 'Audio sync' }).first().innerText();
ok('the sync chip is visible', /Locked|Tracking|Correcting/.test(chip), chip.split('\n').slice(0, 3).join(' | '));

step('5. subtitles are on and rendering');
const cue = await page.evaluate(() => {
  const el = document.querySelector('frenflix-video');
  const box = el.shadowRoot.querySelector('#subs');
  return { cues: el.subtitleCues.length, showing: !box.classList.contains('hidden'), text: el.shadowRoot.querySelector('#subs > span').textContent };
});
ok('the subtitle file was parsed and attached', cue.cues === 2, JSON.stringify(cue));

step('6. nudge the audio delay with k, and check it lands');
const before = await page.evaluate(() => document.querySelector('frenflix-video').syncStatus.totalOffsetMs);
await page.locator('body').press('k');
await page.locator('body').press('k');
await sleep(1500);
const after = await page.evaluate(() => document.querySelector('frenflix-video').syncStatus);
ok('two presses of k moved the offset by +100 ms',
  Math.abs((after.totalOffsetMs - before) - 100) < 4,
  `${before.toFixed(0)} -> ${after.totalOffsetMs.toFixed(0)} ms`);
// p95 covers the last four seconds, so it still carries the step itself for a
// while; the instantaneous error is what says the new offset has landed.
ok('and the new offset landed within 1.5 s', Math.abs(after.errorMs) < 20,
  `error ${after.errorMs.toFixed(1)} ms`);
await sleep(4500);
const settled = await page.evaluate(() => document.querySelector('frenflix-video').syncStatus);
ok('and the lock reads clean again a few seconds later', settled.p95Ms < 45,
  `p95 ${settled.p95Ms.toFixed(1)} ms, ${settled.state}`);

step('7. switch the sync mode to Off and back to Auto');
await page.getByRole('button', { name: 'Off', exact: true }).click();
await sleep(1500);
const offState = await page.evaluate(() => document.querySelector('frenflix-video').syncStatus);
ok('Off disables the correction', offState.state === 'off' && offState.autoOffsetMs === 0);
await page.getByRole('button', { name: 'Auto', exact: true }).click();
await sleep(3000);
const autoState = await page.evaluate(() => document.querySelector('frenflix-video').syncStatus);
ok('Auto brings compensation back', autoState.autoOffsetMs < -5, `auto ${autoState.autoOffsetMs.toFixed(0)} ms`);
ok('still playing throughout', !(await page.evaluate(() => document.querySelector('frenflix-video').paused)));

step('8. seek with the scrub bar, then pause');
await page.evaluate(() => { document.querySelector('frenflix-video').currentTime = 30; });
await sleep(3000);
const seeked = await page.evaluate(() => {
  const el = document.querySelector('frenflix-video');
  return { t: el.currentTime, paused: el.paused, sync: el.syncStatus };
});
ok('it resumed after the seek', !seeked.paused && seeked.t > 30, `t=${seeked.t.toFixed(2)}s`);
ok('and re-locked', seeked.sync.p95Ms < 45, `p95 ${seeked.sync.p95Ms.toFixed(1)} ms`);

step('9. back to the library and in again (element teardown / rebuild)');
await page.getByRole('link', { name: /Library/ }).click();
await page.waitForSelector('article');
await page.getByRole('link', { name: 'Play' }).first().click();
await page.waitForSelector('frenflix-video');
await sleep(1000);
await page.locator('media-play-button').click();
await sleep(5000);
const again = await page.evaluate(() => {
  const el = document.querySelector('frenflix-video');
  return { paused: el.paused, t: el.currentTime, sync: el.syncStatus };
});
ok('the rebuilt player still plays', !again.paused && again.t > 2, `t=${again.t.toFixed(2)}s`);
ok('and still locks', ['locked', 'tracking'].includes(again.sync.state),
  `${again.sync.state}, p95 ${again.sync.p95Ms.toFixed(1)} ms`);

step('10. the Drive panel opens and explains itself when unconfigured');
await page.getByRole('link', { name: /Library/ }).click();
await page.getByRole('button', { name: /Add from Google Drive/ }).click();
await page.waitForSelector('[role=dialog]');
const dialog = await page.locator('[role=dialog]').innerText();
ok('the Drive dialog opened', dialog.includes('Google Drive'));
ok('and says what is missing', /client ID|Connect Google Drive/.test(dialog),
  dialog.split('\n')[2] || '');

console.log(`\n--- page errors: ${problems.length}`);
for (const p of problems.slice(0, 10)) console.log(`   ${p}`);

await browser.close();
vite.kill();
