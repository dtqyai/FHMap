'use strict';
/* Viewport tile loading, cancellation, caching and recovery. */
window.FH3Tiles = ({ map, mapConfigs, scheduleMap }) => {
  const $ = (id) => document.getElementById(id);
  const layers = new Map();
  const tileCache = new Map();
  const MAX_REQUESTS = 4,
    MAX_CACHED_TILES = 96,
    MAX_RETRIES = 2;
  let region = 'main',
    scale = 1,
    tx = 0,
    ty = 0;
  let wantedTiles = new Set(),
    activeRequests = 0,
    maxActiveRequests = 0;
  for (const [key, config] of Object.entries(mapConfigs)) {
    const layer = document.createElement('div'),
      preview = document.createElement('img');
    const [, , cw, ch] = config.crop,
      u = config.unit;
    layer.className = 'map-layer';
    layer.dataset.region = key;
    layer.style.width = cw * u + 'px';
    layer.style.height = ch * u + 'px';
    preview.className = 'map-image map-preview';
    preview.alt = config.name + '地图';
    preview.draggable = false;
    preview.decoding = 'async';
    const previewState = { layer, preview, config, attempts: 0, timer: null };
    preview.addEventListener('load', () => {
      delete layer.dataset.failed;
      previewState.attempts = 0;
      clearTimeout(previewState.timer);
      updateImageStatus();
    });
    preview.addEventListener('error', () => {
      layer.dataset.failed = 'true';
      if (previewState.attempts < MAX_RETRIES && key === region) {
        previewState.timer = setTimeout(
          () => {
            if (key !== region) return;
            previewState.attempts++;
            preview.src = config.tiles.base + '/0/0-0.webp';
          },
          600 * 2 ** previewState.attempts,
        );
      }
      updateImageStatus();
    });
    layer.append(preview);
    $('map-layers').append(layer);
    layers.set(key, previewState);
  }
  function updateImageStatus() {
    const visible = [...layers.entries()]
      .filter(([key]) => key === region)
      .map(([, value]) => value);
    const failed =
      visible.some((v) => v.layer.dataset.failed === 'true') ||
      [...wantedTiles].some((key) => tileCache.get(key)?.state === 'error');
    const pending =
      visible.filter((v) => !v.preview.complete || !v.preview.naturalWidth).length +
      [...wantedTiles].filter((key) => tileCache.get(key)?.state !== 'ready').length;
    map.setAttribute('aria-busy', String(!failed && pending > 0));
    map.dataset.activeRequests = activeRequests;
    map.dataset.maxActiveRequests = maxActiveRequests;
    map.dataset.cachedTiles = tileCache.size;
    $('retry-map').hidden = !failed;
    $('map-status').textContent = failed
      ? '部分底图加载失败'
      : pending
        ? '正在加载底图…'
        : mapConfigs[region].name;
  }
  function updateLayers(next = region) {
    region = next;
    for (const [key, state] of layers) {
      const { layer, preview, config } = state;
      const show = region === key;
      layer.hidden = !show;
      if (show && (!preview.hasAttribute('src') || layer.dataset.failed === 'true')) {
        clearTimeout(state.timer);
        state.attempts = 0;
        delete layer.dataset.failed;
        preview.src = config.tiles.base + '/0/0-0.webp';
      }
    }
    updateImageStatus();
  }
  function disposeTile(entry) {
    entry.cancelled = true;
    clearTimeout(entry.retryTimer);
    entry.controller?.abort();
    entry.cancelDirect?.();
    entry.img.remove();
    if (entry.objectURL) URL.revokeObjectURL(entry.objectURL);
    tileCache.delete(entry.key);
  }
  async function loadTile(entry) {
    entry.state = 'loading';
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.objectURL) {
      URL.revokeObjectURL(entry.objectURL);
      entry.objectURL = null;
    }
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    updateImageStatus();
    try {
      if (location.protocol === 'file:') {
        const loaded = await new Promise((resolve, reject) => {
          entry.img.onload = () => resolve(true);
          entry.img.onerror = () => reject(new Error('Tile loading failed'));
          entry.cancelDirect = () => {
            entry.img.onload = null;
            entry.img.onerror = null;
            entry.img.removeAttribute('src');
            resolve(false);
          };
          entry.img.src = entry.url;
        });
        if (!loaded || entry.cancelled) return;
      } else {
        entry.controller = new AbortController();
        const response = await fetch(entry.url, { signal: entry.controller.signal });
        if (!response.ok) throw new Error('Tile HTTP ' + response.status);
        const blob = await response.blob();
        if (entry.cancelled) return;
        entry.objectURL = URL.createObjectURL(blob);
        entry.img.src = entry.objectURL;
        await entry.img.decode();
        if (entry.cancelled) return;
      }
      entry.state = 'ready';
      entry.img.hidden = false;
    } catch (error) {
      if (!entry.cancelled && error.name !== 'AbortError') {
        entry.state = 'error';
        if (entry.attempts <= MAX_RETRIES)
          entry.retryTimer = setTimeout(
            () => {
              if (entry.cancelled || !wantedTiles.has(entry.key)) return;
              entry.state = 'queued';
              pumpTiles();
            },
            600 * 2 ** (entry.attempts - 1),
          );
      }
    } finally {
      activeRequests--;
      scheduleMap();
      pumpTiles();
      updateImageStatus();
    }
  }
  function pumpTiles() {
    const queue = [...tileCache.values()]
      .filter((e) => e.state === 'queued' && wantedTiles.has(e.key))
      .sort((a, b) => a.priority - b.priority);
    while (activeRequests < MAX_REQUESTS && queue.length) loadTile(queue.shift());
  }
  function tileOnScreen(entry, margin = 0) {
    const x = entry.worldX * scale + tx,
      y = entry.worldY * scale + ty;
    return (
      x + entry.worldW * scale >= -margin &&
      y + entry.worldH * scale >= -margin &&
      x <= map.clientWidth + margin &&
      y <= map.clientHeight + margin
    );
  }
  function updateTiles() {
    const needed = new Set(),
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [regionKey, { layer, config }] of layers) {
      if (layer.hidden) continue;
      const [ox, oy] = config.position,
        [, , cw, ch] = config.crop,
        u = config.unit;
      const levels = config.tiles.levels,
        last = levels.length - 1;
      const z = Math.max(
        0,
        Math.min(last, Math.ceil(last + Math.log2(Math.max(scale * u * dpr, 0.0001)))),
      );
      const level = levels[z],
        size = config.tiles.size;
      const pxPerLevelX = cw / level.width,
        pxPerLevelY = ch / level.height;
      const left = Math.max(0, (-tx / scale - ox) / u),
        top = Math.max(0, (-ty / scale - oy) / u);
      const right = Math.min(cw, ((map.clientWidth - tx) / scale - ox) / u),
        bottom = Math.min(ch, ((map.clientHeight - ty) / scale - oy) / u);
      if (right <= left || bottom <= top) continue;
      const x0 = Math.max(0, Math.floor(left / pxPerLevelX / size)),
        y0 = Math.max(0, Math.floor(top / pxPerLevelY / size));
      const x1 = Math.min(level.cols - 1, Math.floor(right / pxPerLevelX / size)),
        y1 = Math.min(level.rows - 1, Math.floor(bottom / pxPerLevelY / size));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const key = regionKey + '/' + z + '/' + x + '/' + y;
          needed.add(key);
          const localX = x * size * pxPerLevelX * u,
            localY = y * size * pxPerLevelY * u;
          const worldW = Math.min(size, level.width - x * size) * pxPerLevelX * u,
            worldH = Math.min(size, level.height - y * size) * pxPerLevelY * u;
          const priority = Math.hypot(
            (ox + localX + worldW / 2) * scale + tx - map.clientWidth / 2,
            (oy + localY + worldH / 2) * scale + ty - map.clientHeight / 2,
          );
          let entry = tileCache.get(key);
          if (!entry) {
            const img = document.createElement('img');
            img.className = 'map-image map-tile';
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.hidden = true;
            img.style.left = localX + 'px';
            img.style.top = localY + 'px';
            img.style.width = worldW + 'px';
            img.style.height = worldH + 'px';
            img.style.zIndex = z + 1;
            const url = config.tiles.base + '/' + z + '/' + x + '-' + y + '.webp';
            img.dataset.tileUrl = url;
            entry = {
              key,
              region: regionKey,
              url,
              img,
              state: 'queued',
              worldX: ox + localX,
              worldY: oy + localY,
              worldW,
              worldH,
            };
            tileCache.set(key, entry);
            layer.append(img);
          }
          entry.priority = priority;
          entry.lastUsed = performance.now();
        }
    }
    wantedTiles = needed;
    for (const entry of [...tileCache.values()]) {
      if (!needed.has(entry.key) && entry.state !== 'ready') {
        disposeTile(entry);
        continue;
      }
      entry.img.hidden = entry.state !== 'ready' || entry.region !== region || !tileOnScreen(entry);
    }
    const unused = [...tileCache.values()]
      .filter((e) => !needed.has(e.key) && e.state === 'ready')
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (tileCache.size > MAX_CACHED_TILES && unused.length) disposeTile(unused.shift());
    pumpTiles();
    updateImageStatus();
  }
  function retry() {
    for (const [key, state] of layers) {
      if (key !== region || state.layer.dataset.failed !== 'true') continue;
      clearTimeout(state.timer);
      state.attempts = 0;
      delete state.layer.dataset.failed;
      state.preview.src = state.config.tiles.base + '/0/0-0.webp';
    }
    for (const entry of [...tileCache.values()]) if (entry.state === 'error') disposeTile(entry);
    scheduleMap();
  }
  $('retry-map').addEventListener('click', retry);
  window.addEventListener('online', retry);
  function draw(view) {
    ({ region, scale, tx, ty } = view);
    for (const [key, { layer, config }] of layers) {
      const [x, y] = config.position;
      layer.style.transform =
        'translate(' + (x * scale + tx) + 'px,' + (y * scale + ty) + 'px) scale(' + scale + ')';
    }
    updateTiles();
  }
  return { show: updateLayers, draw };
};
