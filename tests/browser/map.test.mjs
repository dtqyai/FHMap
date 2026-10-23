import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../dist/', import.meta.url));
const screenshots = fileURLToPath(new URL('../../verification/', import.meta.url));
let server, browser, context, page, url;
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message = 'condition timed out', timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(40);
  }
  assert.fail(message);
}
async function total(value) {
  await until(
    async () => (await page.locator('#total-done').textContent()) === String(value),
    'progress did not become ' + value,
  );
}
async function ready() {
  await until(
    async () => (await page.locator('#map-status').textContent()) === '澳洲大陆',
    'map did not finish loading',
  );
}
async function importProgress(ids, replace = false, target = page) {
  await target.locator('#import-button').click();
  await target
    .locator('#backup-content')
    .fill(JSON.stringify({ app: 'fh3-local-map', version: 1, collected: ids }));
  await target.locator('#replace-progress').setChecked(replace);
  await target.locator('#backup-submit').click();
}
async function marker() {
  await page.evaluate(() => new Promise(requestAnimationFrame));
  for (let i = 0; i < 8; i++) {
    const found = await page.locator('.marker:not([hidden])').evaluateAll((elements) => {
      const map = document.querySelector('#map').getBoundingClientRect();
      return elements.find((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.left > map.left + 70 &&
          r.right < map.right - 90 &&
          r.top > map.top + 90 &&
          r.bottom < map.bottom - 60 &&
          el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        );
      })?.dataset.id;
    });
    if (found) return page.locator('.marker[data-id="' + found + '"]');
    await page.locator('#map').focus();
    await page.keyboard.press('+');
  }
  throw new Error('No selectable individual marker');
}
before(async () => {
  await stat(resolve(root, 'index.html'));
  await mkdir(screenshots, { recursive: true });
  server = createServer(async (req, res) => {
    try {
      const path = resolve(
        root,
        '.' +
          decodeURIComponent(
            new URL(req.url, 'http://localhost').pathname === '/'
              ? '/index.html'
              : new URL(req.url, 'http://localhost').pathname,
          ),
      );
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      res
        .writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
});
afterEach(async () => {
  await context?.close();
});

test('deployment loads scripts, region counts, and limits concurrent tile requests', async () => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await ready();
  assert.equal(await page.locator('#visible-count').textContent(), '183');
  for (const region of ['blizzard', 'hotwheels']) {
    await page.locator('button[data-region="' + region + '"]').click();
    assert.equal(await page.locator('#visible-count').textContent(), '26');
  }
  assert.ok(Number(await page.locator('#map').getAttribute('data-max-active-requests')) <= 4);
  assert.deepEqual(errors, []);
});
test('tap toggles a point and reload preserves the saved progress', async () => {
  await page.goto(url);
  await ready();
  const el = await marker(),
    id = await el.getAttribute('data-id');
  await el.click();
  await total(1);
  await page.reload();
  await ready();
  await total(1);
  assert.equal(
    await page.locator('.marker[data-id="' + id + '"]').getAttribute('aria-pressed'),
    'true',
  );
});
test('dragging from a marker pans without collecting; the next click still works', async () => {
  await page.goto(url);
  await ready();
  const el = await marker();
  const box = await el.boundingBox();
  const before = await page
    .locator('.map-layer[data-region="main"]')
    .evaluate((el) => el.style.transform);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 10 });
  await page.mouse.up();
  await until(
    async () =>
      (await page
        .locator('.map-layer[data-region="main"]')
        .evaluate((el) => el.style.transform)) !== before,
  );
  await total(0);
  const zoom = await page.locator('#zoom-level').textContent();
  await page.locator('#zoom-in').click();
  await until(
    async () => (await page.locator('#zoom-level').textContent()) !== zoom,
    'zoom controls blocked after drag',
  );
  await (await marker()).click();
  await total(1);
});
test('shortcuts act only inside map and preserve Ctrl, Meta and Alt combinations', async () => {
  await page.goto(url);
  await ready();
  const results = await page.evaluate(() => {
    const map = document.querySelector('#map'),
      zoom = document.querySelector('#zoom-level');
    const before = zoom.textContent;
    const defaults = [];
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'])
      for (const key of ['0', '-', '+']) {
        const event = new KeyboardEvent('keydown', {
          key,
          [modifier]: true,
          bubbles: true,
          cancelable: true,
        });
        map.dispatchEvent(event);
        defaults.push(event.defaultPrevented);
      }
    const outside = new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    return { defaults, outside: outside.defaultPrevented, before, after: zoom.textContent };
  });
  assert.ok(results.defaults.every((value) => value === false));
  assert.equal(results.outside, false);
  assert.equal(results.before, results.after);
  await page.locator('#map').focus();
  await page.keyboard.press('+');
  await until(async () => (await page.locator('#zoom-level').textContent()) !== results.before);
});
test('all points remain individual at full-map and enlarged zoom levels', async () => {
  await page.goto(url);
  await ready();
  await page.locator('#fit-map').click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await until(async () => (await page.locator('.marker:not([hidden])').count()) === 183);
  assert.equal(await page.locator('.marker-cluster,#clusters').count(), 0);
  const zoom = await page.locator('#zoom-level').textContent();
  await (await marker()).click();
  await total(1);
  assert.equal(await page.locator('#zoom-level').textContent(), zoom, 'collecting should not zoom');
  await page.locator('#zoom-in').click();
  await until(async () => (await page.locator('#zoom-level').textContent()) !== zoom);
  assert.equal(await page.locator('.marker:not([hidden])').count(), 183);
  assert.equal(await page.locator('.marker-cluster,#clusters').count(), 0);
});
test('preview and detail tiles automatically recover from temporary HTTP failures', async () => {
  const attempts = new Map();
  await context.route('**/assets/maps/main/**/*.webp', (route) => {
    const key = route.request().url(),
      n = (attempts.get(key) || 0) + 1;
    attempts.set(key, n);
    return n <= 2 ? route.fulfill({ status: 503, body: 'temporary failure' }) : route.continue();
  });
  await page.goto(url);
  await ready();
  assert.ok([...attempts.values()].every((n) => n >= 3));
  assert.equal(
    await page
      .locator('.map-preview')
      .first()
      .evaluate((el) => el.naturalWidth > 0),
    true,
  );
  assert.equal(await page.locator('#retry-map').isVisible(), false);
});
test('permanent failures stop retrying and the retry button recovers both preview and details', async () => {
  let fail = true;
  const attempts = new Map();
  await context.route('**/assets/maps/main/**/*.webp', (route) => {
    const key = route.request().url();
    attempts.set(key, (attempts.get(key) || 0) + 1);
    return fail ? route.fulfill({ status: 503, body: 'failure' }) : route.continue();
  });
  await page.goto(url);
  await pause(2500);
  const count = [...attempts.values()].reduce((a, b) => a + b, 0);
  await pause(400);
  assert.equal(
    [...attempts.values()].reduce((a, b) => a + b, 0),
    count,
  );
  assert.ok([...attempts.values()].every((n) => n === 3));
  assert.equal(await page.locator('#retry-map').isVisible(), true);
  fail = false;
  await page.locator('#retry-map').click();
  await ready();
  assert.equal(
    await page.locator('.map-layer[data-region="main"]').getAttribute('data-failed'),
    null,
  );
  assert.ok(Number(await page.locator('#map').getAttribute('data-max-active-requests')) <= 4);
});
test('online event retries failed previews and tiles without a page reload', async () => {
  let fail = true;
  await context.route('**/assets/maps/main/**/*.webp', (route) =>
    fail ? route.fulfill({ status: 503, body: 'failure' }) : route.continue(),
  );
  await page.goto(url);
  await until(async () => await page.locator('#retry-map').isVisible());
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await ready();
});
test('failed detail tiles are fetched again after leaving and returning to a region', async () => {
  let fail = true;
  await context.route('**/assets/maps/main/**/*.webp', (route) =>
    fail && !route.request().url().endsWith('/0/0-0.webp')
      ? route.fulfill({ status: 503, body: 'failure' })
      : route.continue(),
  );
  await page.goto(url);
  await until(async () => await page.locator('#retry-map').isVisible());
  await page.locator('button[data-region="blizzard"]').click();
  fail = false;
  await page.locator('button[data-region="main"]').click();
  await ready();
});
test('merge, replacement and import undo preserve progress', async () => {
  await page.goto(url);
  await ready();
  await importProgress([1]);
  await total(1);
  await importProgress([2]);
  await total(2);
  await importProgress([3], true);
  await total(1);
  await page.locator('#undo-button').click();
  await total(2);
  assert.deepEqual(
    await page.evaluate(() => [1, 2, 3].map((id) => localStorage.getItem('fh3.collect.v1.' + id))),
    ['1', '1', null],
  );
});
test('malformed or duplicate backup IDs do not change progress', async () => {
  await page.goto(url);
  await ready();
  await importProgress([1]);
  await total(1);
  await importProgress([2, 2]);
  assert.equal(await page.locator('#backup-dialog').isVisible(), true);
  assert.match(await page.locator('#backup-error').textContent(), /重复或无效/);
  await total(1);
});
test('storage failure rolls back import including previously missing keys', async () => {
  await page.goto(url);
  await ready();
  await importProgress([1]);
  await total(1);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'fh3.collect.v1.3' && !failed) {
        failed = true;
        throw new DOMException('Quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await importProgress([2, 3], true);
  await total(1);
  assert.match(await page.locator('#backup-error').textContent(), /已恢复原进度/);
  assert.deepEqual(
    await page.evaluate(() => [1, 2, 3].map((id) => localStorage.getItem('fh3.collect.v1.' + id))),
    ['1', null, null],
  );
});
test('two tabs synchronize independent edits and undo does not erase unrelated progress', async () => {
  await page.goto(url);
  await ready();
  const second = await context.newPage();
  await second.goto(url);
  await importProgress([1]);
  await until(async () => (await second.locator('#total-done').textContent()) === '1');
  await importProgress([2], false, second);
  await total(2);
  await page.locator('#undo-button').click();
  await total(1);
  assert.equal(await page.evaluate(() => localStorage.getItem('fh3.collect.v1.2')), '1');
});
test('export downloads a valid backup with the current progress', async () => {
  await page.goto(url);
  await ready();
  await importProgress([1, 2]);
  await total(2);
  await page.locator('#export-button').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#backup-submit').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream(),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(backup.app, 'fh3-local-map');
  assert.deepEqual(backup.collected, [1, 2]);
});
test('mobile drawer moves and restores focus; touch tap and pinch do not miscollect', async () => {
  await context.close();
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  page = await context.newPage();
  await page.goto(url);
  await ready();
  await page.locator('#mobile-filters').tap();
  assert.equal(
    await page.locator('#close-sidebar').evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(
    await page.locator('#mobile-filters').evaluate((el) => el === document.activeElement),
    true,
  );
  const el = await marker(),
    box = await el.boundingBox();
  await el.tap();
  await total(1);
  await el.tap();
  await total(0);
  const cdp = await context.newCDPSession(page);
  const zoom = await page.locator('#zoom-level').textContent();
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [p, { x: p.x + 50, y: p.y + 20, id: 2 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { ...p, x: p.x - 25 },
      { x: p.x + 80, y: p.y + 35, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await total(0);
  await until(async () => (await page.locator('#zoom-level').textContent()) !== zoom);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
test('desktop and narrow layouts render without errors or horizontal overflow', async () => {
  await page.goto(url);
  await ready();
  await page.screenshot({ path: resolve(screenshots, 'fixed-desktop.png') });
  await page.setViewportSize({ width: 320, height: 700 });
  await pause(100);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#mobile-filters').click();
  await until(
    async () =>
      await page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().x >= -0.5),
    'drawer did not finish opening',
  );
  await page.screenshot({ path: resolve(screenshots, 'fixed-mobile.png') });
});

test('status and category filters update individual marker visibility', async () => {
  await page.goto(url);
  await ready();
  await importProgress([1, 2, 3]);
  await total(3);
  await page.locator('[data-status="done"]').click();
  await until(async () => (await page.locator('#visible-count').textContent()) === '3');
  await pause(40);
  const count = await page.locator('.marker:not([hidden])').count();
  assert.equal(count, 3);
  await page.locator('#toggle-types').click();
  await pause(40);
  assert.equal(await page.locator('#visible-count').textContent(), '0');
  assert.equal(await page.locator('.marker:not([hidden])').count(), 0);
});

test('pinching from an individual marker follows repeated touch moves', async () => {
  await context.close();
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  page = await context.newPage();
  await page.goto(url);
  await ready();
  const target = await (await marker()).boundingBox();
  assert.ok(target, 'an individual marker is needed');
  const x = target.x + target.width / 2,
    y = target.y + target.height / 2,
    cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x, y, id: 1 },
      { x: x + 35, y: y + 10, id: 2 },
    ],
  });
  let previous = 0;
  for (let step = 1; step <= 3; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - step * 12, y, id: 1 },
        { x: x + 35 + step * 12, y: y + 10, id: 2 },
      ],
    });
    await pause(40);
    const zoom = Number((await page.locator('#zoom-level').textContent()).replace('%', ''));
    assert.ok(zoom > previous, 'pinch stopped following fingers');
    previous = zoom;
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await total(0);
  assert.equal(await page.locator('#map').getAttribute('class'), 'map');
});
