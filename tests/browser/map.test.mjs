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
      .locator('.map-layer[data-region="main"] .map-preview')
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

test('an open export stays current and download refreshes the stored progress', async () => {
  await page.goto(url);
  await ready();
  await page.locator('#export-button').click();
  const second = await context.newPage();
  await second.goto(url);
  await importProgress([1, 2, 3], false, second);
  await total(3);
  await until(
    async () =>
      JSON.parse(await page.locator('#backup-content').inputValue()).collected.length === 3,
  );
  assert.match(await page.locator('#backup-intro').textContent(), /3 \/ 235/);
  // Download must read storage even if the displayed snapshot is stale.
  await page.locator('#backup-content').evaluate((el) => {
    el.value = '{"collected":[]}';
  });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#backup-submit').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream(),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)).collected, [1, 2, 3]);
});
test('export reports a read failure instead of downloading a stale backup', async () => {
  await page.goto(url);
  await ready();
  await importProgress([1]);
  await page.locator('#export-button').click();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.evaluate(() => {
    Storage.prototype.getItem = () => {
      throw new Error('Denied');
    };
  });
  await page.locator('#backup-submit').click();
  assert.match(await page.locator('#backup-error').textContent(), /无法读取最新进度/);
  assert.equal(downloads, 0);
  assert.equal(await page.locator('#backup-dialog').isVisible(), true);
});
test('import undo preserves a point another tab cancelled and marked again', async () => {
  await page.goto(url);
  await ready();
  const second = await context.newPage();
  await second.goto(url);
  await importProgress([1, 2]);
  await second.evaluate(() => {
    const progress = window.FH3Progress.create(window.FH3_DATA.points.map((p) => p[0]));
    progress.set(1, false);
    progress.set(1, true);
  });
  await page.locator('#undo-button').click();
  await total(1);
  assert.deepEqual(
    await page.evaluate(() => [1, 2].map((id) => localStorage.getItem('fh3.collect.v1.' + id))),
    ['1', null],
  );
});
test('tabbing through offscreen markers pans the map without scrolling its controls', async () => {
  await page.goto(url);
  await ready();
  await page.locator('#map').focus();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const position = await page.evaluate(() => {
      const map = document.querySelector('#map'),
        rect = map.getBoundingClientRect(),
        marker = document.activeElement,
        point = marker.getBoundingClientRect();
      return {
        isMarker: marker.matches('.marker'),
        scrollX: map.scrollLeft,
        scrollY: map.scrollTop,
        barBottom: document.querySelector('.map-bottom').getBoundingClientRect().bottom,
        mapBottom: rect.bottom,
        onScreen:
          point.x >= rect.x &&
          point.right <= rect.right &&
          point.y >= rect.y &&
          point.bottom <= rect.bottom,
      };
    });
    assert.equal(position.isMarker, true);
    assert.equal(position.scrollX, 0);
    assert.equal(position.scrollY, 0);
    assert.ok(Math.abs(position.barBottom - position.mapBottom) < 1);
    assert.equal(position.onScreen, true);
  }
  await page.screenshot({ path: resolve(screenshots, 'keyboard-navigation.png') });
  await page.keyboard.press('Enter');
  await total(1);
});
test('hanging previews and detail requests time out, release slots and recover', async () => {
  let hang = true;
  const requests = [];
  await context.route('**/assets/maps/main/**/*.webp', (route) => {
    requests.push(route.request().url());
    if (!hang) return route.continue();
  });
  await page.clock.install();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await until(
    async () =>
      requests.length >= 5 &&
      Number(await page.locator('#map').getAttribute('data-active-requests')) === 4,
  );
  await page.clock.fastForward(5000);
  assert.equal(await page.locator('#retry-map').isVisible(), false);
  hang = false;
  await page.clock.fastForward(5001);
  await until(
    async () => await page.locator('#retry-map').isVisible(),
    'timeout did not expose retry',
  );
  await until(async () => requests.length > 5, 'timed out requests did not release queue slots');
  await page.locator('#retry-map').click();
  await ready();
  assert.equal(await page.locator('#retry-map').isVisible(), false);
  assert.ok(Number(await page.locator('#map').getAttribute('data-max-active-requests')) <= 4);
});
test('touch targets are 44 pixels and dense taps select the nearest individual point', async () => {
  await context.close();
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  page = await context.newPage();
  await page.goto(url);
  await ready();
  const targets = await page.locator('.marker:not([hidden])').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }),
  );
  assert.ok(targets.every((r) => Math.round(r.width) >= 44 && Math.round(r.height) >= 44));
  const crowded = await page.evaluate(() => {
    const rect = document.querySelector('#map').getBoundingClientRect();
    for (const el of document.querySelectorAll('.marker:not([hidden])')) {
      const r = el.getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2,
        hit = document.elementFromPoint(x, y)?.closest('.marker');
      if (
        x > rect.x + 30 &&
        x < rect.right - 80 &&
        y > rect.y + 90 &&
        y < rect.bottom - 60 &&
        hit &&
        hit !== el
      )
        return { id: el.dataset.id, x, y };
    }
  });
  assert.ok(crowded, 'a dense area is required to test overlapping hit targets');
  await page.touchscreen.tap(crowded.x, crowded.y);
  await total(1);
  assert.equal(
    await page.locator('.marker[data-id="' + crowded.id + '"]').getAttribute('aria-pressed'),
    'true',
  );
  await page.touchscreen.tap(crowded.x, crowded.y);
  await total(0);
  const edge = await page.evaluate(() => {
    const rect = document.querySelector('#map').getBoundingClientRect(),
      points = [...document.querySelectorAll('.marker:not([hidden])')].map((el) => {
        const r = el.getBoundingClientRect();
        return { el, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    for (const p of points)
      for (const [dx, dy] of [
        [18, 0],
        [-18, 0],
        [0, 18],
        [0, -18],
      ]) {
        const x = p.x + dx,
          y = p.y + dy;
        if (x < rect.x + 30 || x > rect.right - 80 || y < rect.y + 90 || y > rect.bottom - 60)
          continue;
        const nearest = points
          .filter((q) => Math.abs(q.x - x) <= 22 && Math.abs(q.y - y) <= 22)
          .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
        if (nearest === p && document.elementFromPoint(x, y)?.closest('.marker'))
          return { id: p.el.dataset.id, x, y };
      }
  });
  assert.ok(edge, 'an enlarged target edge is required');
  await page.touchscreen.tap(edge.x, edge.y);
  await total(1);
  assert.equal(
    await page.locator('.marker[data-id="' + edge.id + '"]').getAttribute('aria-pressed'),
    'true',
  );
  await page.screenshot({ path: resolve(screenshots, 'touch-map.png') });
});
test('drawer restores its scrim, focus and inert state across layout changes', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await ready();
  await page.locator('#mobile-filters').click();
  await page.setViewportSize({ width: 1000, height: 700 });
  await until(async () => await page.locator('#sidebar-scrim').evaluate((el) => el.hidden));
  assert.equal(await page.locator('.main').evaluate((el) => el.inert), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => await page.locator('#sidebar-scrim').isVisible());
  assert.equal(await page.locator('.main').evaluate((el) => el.inert), true);
  assert.equal(await page.locator('#mobile-filters').getAttribute('aria-expanded'), 'true');
  await page.locator('#sidebar-scrim').click({ position: { x: 380, y: 200 } });
  assert.equal(await page.locator('.main').evaluate((el) => el.inert), false);
  assert.equal(await page.locator('#sidebar').evaluate((el) => el.inert), true);
  assert.equal(
    await page.locator('#mobile-filters').evaluate((el) => el === document.activeElement),
    true,
  );
});
test('bulk cross-tab synchronization batches reads and only rewrites changed symbols', async () => {
  await page.goto(url);
  await ready();
  const second = await context.newPage();
  await second.goto(url);
  await second.waitForFunction(
    () => document.querySelector('#map-status').textContent === '澳洲大陆',
  );
  await page.evaluate(() => {
    window.syncAudit = { reads: 0, symbols: 0 };
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith(window.FH3Progress.prefix)) window.syncAudit.reads++;
      return original.call(this, key);
    };
    new MutationObserver((records) => {
      window.syncAudit.symbols += records.filter(
        (r) => r.type === 'childList' && r.target.matches?.('.marker-symbol'),
      ).length;
    }).observe(document.querySelector('#markers'), { childList: true, subtree: true });
  });
  const ids = await second.evaluate(() => window.FH3_DATA.points.map((p) => p[0]));
  await importProgress(ids, false, second);
  await total(235);
  const audit = await page.evaluate(() => window.syncAudit);
  assert.equal(audit.symbols, 235);
  assert.ok(audit.reads < 235 * 20, 'storage events were not batched: ' + audit.reads + ' reads');
  console.log('Bulk sync: ' + audit.reads + ' storage reads, ' + audit.symbols + ' symbol updates');
});

test('FH2 tabs load only the selected map and reuse FH3 icons and all category counts', async () => {
  const images = [],
    errors = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'image') images.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await ready();
  assert.equal(await page.title(), 'Forza Horizon Interactive Map');
  assert.equal(await page.locator('.brand strong').textContent(), 'Forza Horizon Interactive Map');
  assert.equal(
    images.some((url) => url.includes('/fh2-')),
    false,
  );
  const fh3TravelIcon = await page
    .locator('.category[data-type="1"] svg')
    .evaluate((el) => el.outerHTML);
  const fh3BarnIcon = await page
    .locator('.category[data-type="5"] svg')
    .evaluate((el) => el.outerHTML);
  await page.locator('[data-game="fh2"]').click();
  await until(async () => (await page.locator('#map-status').textContent()) === '法国与意大利');
  assert.equal(await page.locator('#total-count').textContent(), '/ 266');
  assert.equal(await page.locator('.marker:not([hidden])').count(), 240);
  assert.equal(await page.locator('#categories button').count(), 8);
  assert.deepEqual(await page.locator('.category-count').allTextContents(), [
    '0 / 50',
    '0 / 100',
    '0 / 10',
    '0 / 30',
    '0 / 15',
    '0 / 20',
    '0 / 10',
    '0 / 5',
  ]);
  assert.equal(
    images.some((url) => url.includes('/fh2-storm/')),
    false,
  );
  const travelIcons = await page
    .locator('.category[data-type="1"] svg, .marker[data-id="5"] svg')
    .evaluateAll((elements) => elements.map((el) => el.outerHTML));
  assert.deepEqual(travelIcons, [fh3TravelIcon, fh3TravelIcon]);
  assert.equal(
    await page.locator('.category[data-type="3"] svg').evaluate((el) => el.outerHTML),
    fh3BarnIcon,
  );
  assert.equal(await page.locator('.source-sprite').count(), 0);
  await page.locator('button[data-region="fh2-storm"]').click();
  await until(async () => (await page.locator('#map-status').textContent()) === '风暴岛');
  assert.equal(await page.locator('.marker:not([hidden])').count(), 26);
  assert.deepEqual(await page.locator('.category-count').allTextContents(), ['0 / 25', '0 / 1']);
  assert.equal(await page.locator('#point-source-extra').isVisible(), true);
  await page.locator('#toggle-types').click();
  assert.equal(await page.locator('.marker:not([hidden])').count(), 0);
  assert.equal(await page.locator('#toast').isVisible(), false);
  assert.equal(
    images.some((url) => /\.png(?:\?|$)/i.test(url)),
    false,
  );
  assert.ok(Number(await page.locator('#map').getAttribute('data-max-active-requests')) <= 4);
  assert.deepEqual(errors, []);
});

test('FH2 and FH3 keep independent progress for overlapping IDs through switching and reload', async () => {
  await page.goto(url);
  await ready();
  await page.locator('[data-game="fh2"]').click();
  await page.locator('.marker[data-id="3"]').focus();
  await page.keyboard.press('Enter');
  await total(1);
  assert.equal(await page.locator('#toast').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('fh2.collect.v1.3')), '1');
  assert.equal(await page.evaluate(() => localStorage.getItem('fh3.collect.v1.3')), null);
  await page.locator('[data-game="fh3"]').click();
  await total(0);
  await page.locator('.marker[data-id="3"]').focus();
  await page.keyboard.press('Enter');
  await total(1);
  await page.locator('[data-game="fh2"]').click();
  await total(1);
  await page.locator('.marker[data-id="3"]').focus();
  await page.keyboard.press('Enter');
  await total(0);
  await page.reload();
  await ready();
  await total(1);
  await page.locator('[data-game="fh2"]').click();
  await total(0);
  assert.equal(await page.locator('.marker[data-id="3"]').getAttribute('aria-pressed'), 'false');
});

test('FH2 backups include both regions and cannot import progress into FH3', async () => {
  await page.goto(url);
  await ready();
  await page.locator('[data-game="fh2"]').click();
  await page.locator('#import-button').click();
  await page.locator('#backup-content').fill(
    JSON.stringify({
      app: 'fh2-local-map',
      version: 1,
      collected: [3, 10001, 10026],
    }),
  );
  await page.locator('#backup-submit').click();
  await total(3);
  await page.locator('#export-button').click();
  const backup = JSON.parse(await page.locator('#backup-content').inputValue());
  assert.equal(backup.app, 'fh2-local-map');
  assert.equal(backup.total, 266);
  assert.deepEqual(backup.collected, [3, 10001, 10026]);
  const downloading = page.waitForEvent('download');
  await page.locator('#backup-submit').click();
  assert.match((await downloading).suggestedFilename(), /^FH2-收集进度-/);
  await page.locator('#close-backup').click();
  await page.locator('[data-game="fh3"]').click();
  await page.locator('#import-button').click();
  await page.locator('#backup-content').fill(JSON.stringify(backup));
  await page.locator('#backup-submit').click();
  assert.match(await page.locator('#backup-error').textContent(), /Forza Horizon 3/);
  await total(0);
});

test('game tabs support keyboard navigation and FH2 fits desktop and mobile layouts', async () => {
  await page.goto(url);
  await ready();
  await page.locator('[data-game="fh3"]').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('[data-game="fh2"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#game-panel').getAttribute('aria-labelledby'), 'game-fh2-tab');
  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const region of ['fh2-main', 'fh2-storm']) {
      await page.locator('button[data-region="' + region + '"]').click();
      await until(async () => (await page.locator('#map').getAttribute('aria-busy')) === 'false');
      await page.screenshot({ path: resolve(screenshots, 'fh2-' + region + '-' + name + '.png') });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    if (name === 'mobile') {
      await page.locator('button[data-region="fh2-main"]').click();
      await page.locator('#mobile-filters').click();
      await until(async () => (await page.locator('#sidebar').boundingBox()).x >= 0);
      assert.equal(await page.locator('#categories button').count(), 8);
      await page.screenshot({ path: resolve(screenshots, 'fh2-mobile-filters.png') });
      await page.locator('#close-sidebar').click();
    }
  }
});
