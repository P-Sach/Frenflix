/**
 * Drives the Drive-cache bench: download, resume-from-cache, playability,
 * failure cleanup, eviction.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 5195;
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
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()); });
await page.goto(`http://localhost:${PORT}/test/cache-bench.html`);
await page.waitForFunction('window.__cacheReady === true', null, { timeout: 20000 });

const supported = await page.evaluate(() => window.__cacheBench.supported);
console.log('OPFS available:', supported);

// Clean slate, in case a previous run left something.
await page.evaluate(() => window.__cacheBench.evictAll());

const BIG = {
  url: '/test/media/video-heavy.webm',
  fileId: 'drive-test-heavy',
  name: 'Test Movie (2024) 1080p.webm',
  size: 29361991,
};

console.log('\n--- 1. first download (29 MB, throttled to 4 MB/s) ---');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 10, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 1024 * 1024,
});
const first = await page.evaluate((m) => window.__cacheBench.run(m), BIG);
console.log(JSON.stringify(first, null, 1));

console.log('\n--- 2. second call: should come off disk ---');
const second = await page.evaluate((m) => window.__cacheBench.runCached(m), BIG);
console.log(JSON.stringify(second, null, 1));

console.log('\n--- 3. does the cached copy play, and can it seek? ---');
try {
  const play = await page.evaluate((m) => window.__cacheBench.playable(m), BIG);
  console.log(JSON.stringify(play, null, 1));
} catch (e) {
  console.log('  FAILED:', e.message);
}

console.log('\n--- 4a. a URL that answers with a web page is rejected, not cached ---');
console.log(JSON.stringify(await page.evaluate(() => window.__cacheBench.failure({
  fileId: 'drive-test-missing', url: '/test/media/does-not-exist.webm',
})), null, 1));

console.log('\n--- 4b. a body that is not the size Drive promised is rejected ---');
console.log(JSON.stringify(await page.evaluate(() => window.__cacheBench.failureSized({
  fileId: 'drive-test-short', url: '/test/media/audio.webm', size: 999999999,
})), null, 1));

console.log('\n--- 5. inventory and eviction ---');
console.log(' before:', JSON.stringify(await page.evaluate(() => window.__cacheBench.inventory())));
await page.evaluate(() => window.__cacheBench.evictAll());
await sleep(200);
console.log('  after:', JSON.stringify(await page.evaluate(() => window.__cacheBench.inventory())));

await browser.close();
vite.kill();
