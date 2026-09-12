/**
 * Does the library survive the tab closing?
 *
 * Everything in FrenFlix is client-side, and that used to mean the library
 * evaporated on reload — the reducer held it, and a `File` cannot be written
 * down. Two halves to check, and they are different mechanisms:
 *
 *   1. The graph. Titles, dub pairings, subtitle tracks, the queue, the poster
 *      art and the watch position, all keyed on file fingerprints so they
 *      survive being re-added. Driven here through `<input type=file>`, which
 *      is deliberate: it yields no `FileSystemFileHandle` at all, so this is
 *      exactly the Firefox and Safari path — the library comes back with its
 *      files marked as needing to arrive again, and re-dropping one rejoins
 *      the title it already belonged to rather than duplicating it.
 *
 *   2. The handle. `showOpenFilePicker` cannot be driven from a test, so the
 *      handle round-trip is proven with the one kind of handle a page can make
 *      for itself: an OPFS file handle. It is a real `FileSystemFileHandle`,
 *      it is structured-cloneable the same way, and its permission is always
 *      granted — so storing it in IndexedDB and reopening it in a fresh page
 *      tests precisely the mechanism that carries a dropped file across a
 *      browser restart.
 *
 *   node test/persist-harness.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const media = join(here, 'media');
const PORT = 5211;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = [
  join(media, 'Phase Test (2024) 1080p WEB-DL.webm'),
  join(media, 'Phase.Test.2024.Hindi.DDP5.1.opus'),
  join(media, 'Phase Test (2024).en.srt'),
  join(media, 'Second Film (2023) 1080p WEB-DL.webm'),
];

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

/** What the library looks like from outside: one line per card. */
const cards = (page) => page.$$eval('article', (list) => list.map(
  (a) => a.textContent.replace(/\s+/g, ' ').trim(),
));

const titles = (page) => page.$$eval('article a[href^="/watch/"]', (as) => [
  ...new Set(as.map((a) => a.getAttribute('href'))),
]);

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  // One context throughout: IndexedDB and OPFS are per-origin-per-profile, and
  // the whole point is what survives when the page goes away, not the profile.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // The container has no route to fonts.googleapis.com; that is the
    // network, not the page. Same exclusion as phase45-harness.
    const text = m.text();
    if (m.type() === 'error' && !/404|font|ERR_TUNNEL|ERR_NAME|ERR_CONNECTION/i.test(text)) {
      errors.push(text);
    }
  });

  try {
    console.log('\n=== 1. build a library, then reload the page ===');
    await page.goto(`http://localhost:${PORT}/`);
    await page.setInputFiles('input[type=file]', FILES);
    await page.waitForSelector('article');
    await page.waitForFunction(() => document.querySelectorAll('article').length >= 2);

    // Give it something to remember beyond the mere list: a queue, and a
    // watch position on one title.
    await page.getByRole('button', { name: /Queue all/i }).click();
    const firstHref = (await titles(page))[0];
    await page.evaluate((href) => {
      document.querySelector(`article a[href="${href}"]`).click();
    }, firstHref);
    await page.waitForSelector('frenflix-video');
    await page.waitForFunction(() => document.querySelector('frenflix-video')?.duration > 0);
    await page.evaluate(() => { document.querySelector('frenflix-video').currentTime = 42; });
    await page.locator('media-play-button').click();
    await sleep(1500);
    await page.evaluate(() => document.querySelector('aside nav a[href="/"]').click());
    await page.waitForSelector('article');
    await sleep(1200);

    const before = await cards(page);
    const beforeTitles = await titles(page);
    console.log(`  before: ${beforeTitles.length} titles, ${before.length} cards`);
    check(before.some((c) => /Dub paired/.test(c)), 'the dub paired before reloading');
    check(before.some((c) => /subs/.test(c)), 'and the subtitle track attached');

    // The actual test.
    await page.reload();
    // Tolerant on purpose: when nothing was remembered there are no cards to
    // wait for, and that is the result to report rather than an exception.
    await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
    await sleep(1500);

    const after = await cards(page);
    const afterTitles = await titles(page);
    console.log(`  after:  ${afterTitles.length} titles, ${after.length} cards`);

    check(afterTitles.length === beforeTitles.length,
      'the same titles are there after a reload', `${afterTitles.length} vs ${beforeTitles.length}`);
    check(after.some((c) => /Dub paired/.test(c)), 'the dub pairing survived');
    check(after.some((c) => /subs/.test(c)), 'the subtitle track survived');
    const hasQueue = await page.$$eval('h2', (h) => h.some((x) => /Up next/.test(x.textContent)));
    check(hasQueue, 'the queue survived');
    const hasContinue = await page.$$eval('h2', (h) => h.some((x) => /Continue watching/.test(x.textContent)));
    check(hasContinue, 'and where you were up to');
    const posters = await page.$$eval('article img', (imgs) => imgs.filter((i) => i.src.startsWith('blob:')).length);
    check(posters > 0, 'the poster art came straight back out of the cache', `${posters} poster(s)`);

    console.log('\n=== 2. a library whose files cannot be reopened says so ===');
    const state = await page.evaluate(() => {
      const bar = [...document.querySelectorAll('p')].find((p) => /ready to reopen|cannot reopen/.test(p.textContent));
      const badges = [...document.querySelectorAll('span')]
        .filter((s) => /needs permission|file not loaded/.test(s.textContent)).length;
      return { bar: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : null, badges };
    });
    console.log(`  bar says: ${state.bar || '(nothing)'}`);
    check(state.badges > 0, 'the cards say their files are not loaded', `${state.badges} marked`);
    check(Boolean(state.bar), 'and the library says what to do about it');

    console.log('\n=== 3. the same file again rejoins its title ===');
    const countBefore = (await titles(page)).length;
    await page.setInputFiles('input[type=file]', FILES);
    await sleep(1500);
    const countAfter = (await titles(page)).length;
    check(countAfter === countBefore, 'no duplicate titles appeared',
      `${countBefore} → ${countAfter}`);
    const stillPaired = (await cards(page)).some((c) => /Dub paired/.test(c));
    check(stillPaired, 'and the pairing is still the one it had');
    const marked = await page.evaluate(() => [...document.querySelectorAll('span')]
      .filter((s) => /needs permission|file not loaded/.test(s.textContent)).length);
    check(marked === 0, 'nothing is marked as unavailable any more', `${marked} marked`);

    console.log('\n=== 4. a real file handle, stored and reopened in a fresh page ===');
    // Put a file in the origin private file system and take a handle to it.
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('article', { timeout: 15000 });
    const made = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle('handle-probe.txt', { create: true });
      const w = await handle.createWritable();
      await w.write('the bytes behind a stored handle');
      await w.close();
      const db = await new Promise((res) => {
        const req = indexedDB.open('handle-probe', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('h');
        req.onsuccess = () => res(req.result);
      });
      await new Promise((res, rej) => {
        const t = db.transaction('h', 'readwrite');
        t.objectStore('h').put(handle, 'probe');
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      return (await handle.queryPermission?.({ mode: 'read' })) || 'granted';
    });
    check(made === 'granted', 'a handle can be stored in IndexedDB at all', `permission ${made}`);

    // A brand new page: nothing in memory, only what was written down.
    const page2 = await ctx.newPage();
    await page2.goto(`http://localhost:${PORT}/`);
    const reopened = await page2.evaluate(async () => {
      const db = await new Promise((res) => {
        const req = indexedDB.open('handle-probe', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('h');
        req.onsuccess = () => res(req.result);
      });
      const handle = await new Promise((res) => {
        const t = db.transaction('h', 'readonly');
        const r = t.objectStore('h').get('probe');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      if (!handle) return { ok: false, why: 'nothing came back out of IndexedDB' };
      const perm = (await handle.queryPermission?.({ mode: 'read' })) || 'granted';
      if (perm !== 'granted') return { ok: false, why: `permission ${perm}` };
      const file = await handle.getFile();
      return { ok: true, text: await file.text(), name: handle.name };
    });
    check(reopened.ok && reopened.text === 'the bytes behind a stored handle',
      'and reopened in a later page to give back the same bytes',
      reopened.ok ? `"${reopened.text}"` : reopened.why);
    await page2.close();

    console.log(`\n  page errors: ${errors.length}`);
    if (errors.length) errors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
    check(errors.length === 0, 'no page errors throughout (blocked web fonts aside)', errors[0] || '');
  } finally {
    await browser.close();
    vite.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
