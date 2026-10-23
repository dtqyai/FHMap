(() => {
  'use strict';
  const { types, points } = window.FH3_DATA;
  const mapConfigs = window.FH3_MAPS;
  const $ = (id) => document.getElementById(id);
  const PREFIX = window.FH3Progress.prefix;
  const regions = {};
  for (const [key, config] of Object.entries(mapConfigs)) {
    const [x, y] = config.position,
      [, , w, h] = config.crop;
    regions[key] = { name: config.name, box: [x, y, w * config.unit, h * config.unit] };
  }
  function imagePoint(key, x, y) {
    const config = mapConfigs[key],
      [a, b] = config.oldToMap || config.oldToImage;
    return [a[0] * x + a[1] * y + a[2], b[0] * x + b[1] * y + b[2]];
  }
  const byId = new Map();
  const collected = new Set();
  const enabledTypes = new Set(Object.keys(types).map(Number));
  const map = $('map');
  let region = 'main',
    status = 'all';
  let scale = 1,
    tx = 0,
    ty = 0,
    fitScale = 1,
    renderRequest = 0;
  let undo = null,
    toastTimer,
    backupMode = 'export',
    lastMapSize;
  const tiles = window.FH3Tiles({ map, mapConfigs, scheduleMap });
  const number = (id) => '#' + String(id).padStart(3, '0');
  const svg = (body) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>';
  function icon(type) {
    const key = types[type].icon;
    if (key === 'travel') return svg('<path d="m13 2-8 12h6l-1 8 9-13h-7Z"/>');
    if (key === 'barn')
      return svg(
        '<path d="m3 10 9-7 9 7v11H3Z"/><path d="M8 21V11h8v10M8 15h8m-8-4 8 10m0-10L8 21"/>',
      );
    if (key === 'camera')
      return svg('<path d="M3 7h5l2-3h4l2 3h5v13H3Z"/><circle cx="12" cy="13" r="4"/>');
    return key;
  }
  for (const [id, type, x, y] of points) {
    const key = types[type].region,
      config = mapConfigs[key];
    const [imageX, imageY] = imagePoint(key, x, y),
      [cx, cy] = config.crop,
      [ox, oy] = config.position;
    const p = {
      id,
      type,
      x: ox + (imageX - cx) * config.unit,
      y: oy + (imageY - cy) * config.unit,
      region: key,
    };
    byId.set(id, p);
    const button = document.createElement('button');
    button.className = 'marker';
    button.dataset.id = id;
    button.style.setProperty('--color', types[type].color);
    button.innerHTML = icon(type);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (suppressClick && e.detail !== 0) return;
      setCollected(id, !collected.has(id));
    });
    p.el = button;
    $('markers').append(button);
  }
  const progress = window.FH3Progress.create([...byId.keys()]);
  function updateSaveStatus(ok, reason = '') {
    $('save-status').classList.toggle('error-state', !ok);
    $('save-status').replaceChildren();
    $('save-status').append(
      document.createElement('i'),
      document.createTextNode(
        ok ? '进度自动保存在此浏览器' : reason || '浏览器无法保存，请导出进度备份',
      ),
    );
  }
  function loadProgress() {
    try {
      const next = progress.read();
      collected.clear();
      next.forEach((id) => collected.add(id));
      return true;
    } catch {
      updateSaveStatus(false);
      notify('无法读取浏览器存储；请允许本地存储后刷新。');
      return false;
    }
  }
  function setCollected(id, value) {
    try {
      progress.set(id, value);
      updateSaveStatus(true);
    } catch {
      updateSaveStatus(false, '保存失败，本次标记未更改');
      notify('进度保存失败。请检查浏览器存储空间或隐私设置。');
      return false;
    }
    if (value) collected.add(id);
    else collected.delete(id);
    render();
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    undo = null;
    return true;
  }
  function notify(message, canUndo = false) {
    clearTimeout(toastTimer);
    $('toast-text').textContent = message;
    $('undo-button').hidden = !canUndo;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => {
      $('toast').hidden = true;
    }, 6500);
  }
  function regionPoints() {
    return [...byId.values()].filter((p) => p.region === region);
  }
  function matches(p) {
    if (p.region !== region) return false;
    if (!enabledTypes.has(p.type)) return false;
    if ((status === 'todo' && collected.has(p.id)) || (status === 'done' && !collected.has(p.id)))
      return false;
    return true;
  }
  function buildCategories() {
    $('categories').replaceChildren();
    for (const [key, t] of Object.entries(types)) {
      if (t.region !== region) continue;
      const id = Number(key),
        button = document.createElement('button');
      button.className = 'category';
      button.dataset.type = id;
      button.style.setProperty('--color', t.color);
      button.innerHTML =
        '<span class="category-icon">' +
        icon(id) +
        '</span><span class="category-name"></span><span class="category-count"><b>0</b> / ' +
        t.total +
        '</span><span class="category-check" aria-hidden="true">✓</span>';
      button.querySelector('.category-name').textContent = t.short;
      button.addEventListener('click', () => {
        if (enabledTypes.has(id)) enabledTypes.delete(id);
        else enabledTypes.add(id);
        render();
      });
      $('categories').append(button);
    }
  }
  function render() {
    const done = collected.size,
      percent =
        done === 0 ? 0 : done === points.length ? 100 : ((done / points.length) * 100).toFixed(1),
      current = regionPoints();
    $('total-done').textContent = done;
    $('total-percent').textContent = percent + '%';
    $('total-bar').style.width = percent + '%';
    $('remaining').textContent = '未收集 ' + (points.length - done) + ' 个';
    let visible = 0;
    for (const p of byId.values()) {
      const checked = collected.has(p.id),
        show = matches(p);
      visible += Number(show);
      p.el.hidden = !show;
      p.el.classList.toggle('done', checked);
      p.el.setAttribute(
        'aria-label',
        types[p.type].name +
          ' ' +
          number(p.id) +
          '，' +
          (checked ? '已收集，点击取消' : '未收集，点击收集'),
      );
      p.el.setAttribute('aria-pressed', String(checked));
      p.el.title = types[p.type].name + ' ' + number(p.id) + (checked ? ' · 已收集' : ' · 未收集');
      p.el.innerHTML = checked ? '✓' : icon(p.type);
    }
    for (const button of $('categories').children) {
      const type = Number(button.dataset.type),
        count = points.filter((p) => p[1] === type && collected.has(p[0])).length;
      button.setAttribute('aria-pressed', String(enabledTypes.has(type)));
      button.setAttribute(
        'aria-label',
        types[type].name +
          '，已收集 ' +
          count +
          ' / ' +
          types[type].total +
          '，' +
          (enabledTypes.has(type) ? '点击隐藏' : '点击显示'),
      );
      button.querySelector('b').textContent = count;
    }
    const activeTypes = Object.entries(types)
      .filter(([, t]) => t.region === region)
      .map(([k]) => Number(k));
    $('toggle-types').textContent = activeTypes.every((t) => enabledTypes.has(t))
      ? '全部隐藏'
      : '全部显示';
    $('visible-count').textContent = visible;
    $('mobile-count').textContent = visible;
    $('region-progress').textContent =
      current.filter((p) => collected.has(p.id)).length + ' / ' + current.length + ' 已收集';
    for (const b of $('status-filter').children)
      b.setAttribute('aria-pressed', String(b.dataset.status === status));
    scheduleMap();
  }
  function scheduleMap() {
    if (renderRequest) return;
    renderRequest = requestAnimationFrame(() => {
      renderRequest = 0;
      drawMap();
    });
  }
  function clampPosition() {
    const [x, y, w, h] = regions[region].box;
    tx = Math.max(60 - (x + w) * scale, Math.min(map.clientWidth - 60 - x * scale, tx));
    ty = Math.max(60 - (y + h) * scale, Math.min(map.clientHeight - 60 - y * scale, ty));
  }
  function drawMap() {
    clampPosition();
    const markerSize = Math.max(14, Math.min(26, scale * 35 + 5));
    map.style.setProperty('--marker-size', markerSize + 'px');
    layoutMarkers();
    $('zoom-level').textContent = Math.round(scale * 100) + '%';
    tiles.draw({ region, scale, tx, ty });
  }
  function layoutMarkers() {
    for (const p of byId.values()) {
      if (p.el.hidden) continue;
      p.el.style.transform =
        'translate(' + (p.x * scale + tx) + 'px,' + (p.y * scale + ty) + 'px) translate(-50%,-50%)';
    }
  }
  function fitMap() {
    const [x, y, w, h] = regions[region].box;
    const pad = map.clientWidth < 500 ? 26 : 40;
    fitScale = Math.min((map.clientWidth - pad * 2) / w, (map.clientHeight - pad * 2 - 25) / h);
    scale = Math.max(0.1, fitScale);
    tx = (map.clientWidth - w * scale) / 2 - x * scale;
    ty = (map.clientHeight - 25 - h * scale) / 2 - y * scale;
    scheduleMap();
  }
  function zoom(factor, x = map.clientWidth / 2, y = map.clientHeight / 2) {
    const next = Math.min(8, Math.max(Math.min(fitScale * 0.65, 0.15), scale * factor));
    const ratio = next / scale;
    tx = x - (x - tx) * ratio;
    ty = y - (y - ty) * ratio;
    scale = next;
    scheduleMap();
  }
  function changeRegion(next) {
    region = next;
    for (const b of $('regions').children)
      b.setAttribute('aria-pressed', String(b.dataset.region === region));
    tiles.show(region);
    buildCategories();
    fitMap();
    render();
  }
  function syncSidebar() {
    const mobile = innerWidth <= 760,
      open = $('sidebar').classList.contains('open');
    $('sidebar').inert = mobile && !open;
    document.querySelector('.main').inert = mobile && open;
    if (!mobile) $('sidebar-scrim').hidden = true;
  }
  function closeSidebar() {
    const wasOpen = $('sidebar').classList.contains('open');
    $('sidebar').classList.remove('open');
    $('sidebar-scrim').hidden = true;
    $('mobile-filters').setAttribute('aria-expanded', 'false');
    syncSidebar();
    if (wasOpen && innerWidth <= 760) $('mobile-filters').focus();
  }
  window.addEventListener('resize', syncSidebar);
  syncSidebar();
  $('regions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-region]');
    if (b) changeRegion(b.dataset.region);
  });
  $('status-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) {
      status = b.dataset.status;
      render();
    }
  });
  $('toggle-types').addEventListener('click', () => {
    const active = Object.entries(types)
      .filter(([, t]) => t.region === region)
      .map(([k]) => Number(k));
    const hide = active.every((t) => enabledTypes.has(t));
    active.forEach((t) => (hide ? enabledTypes.delete(t) : enabledTypes.add(t)));
    render();
  });
  $('zoom-in').addEventListener('click', () => zoom(1.3));
  $('zoom-out').addEventListener('click', () => zoom(1 / 1.3));
  $('fit-map').addEventListener('click', fitMap);
  $('dim-map').addEventListener('click', () => {
    const dim = map.classList.toggle('dim');
    $('dim-map').setAttribute('aria-pressed', String(dim));
  });
  $('mobile-filters').setAttribute('aria-expanded', 'false');
  $('mobile-filters').addEventListener('click', () => {
    $('sidebar').classList.add('open');
    $('sidebar-scrim').hidden = false;
    $('mobile-filters').setAttribute('aria-expanded', 'true');
    syncSidebar();
    $('close-sidebar').focus();
  });
  $('close-sidebar').addEventListener('click', closeSidebar);
  $('sidebar-scrim').addEventListener('click', closeSidebar);
  $('close-toast').addEventListener('click', () => {
    $('toast').hidden = true;
  });
  $('undo-button').addEventListener('click', () => {
    if (!undo) return;
    try {
      progress.undo(undo);
      undo = null;
      loadProgress();
      render();
      notify('已撤销上次操作');
    } catch {
      loadProgress();
      render();
      updateSaveStatus(false);
      notify('撤销保存失败，请检查浏览器存储后重试。');
    }
  });
  map.addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('.map-tools')) return;
      e.preventDefault();
      const rect = map.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );
  map.addEventListener(
    'click',
    (e) => {
      if (suppressClick && e.detail !== 0 && e.target.closest('.marker')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  const pointers = new Map();
  let gesture = null,
    suppressClick = false;
  function startGesture() {
    const ps = [...pointers.values()],
      r = map.getBoundingClientRect();
    if (ps.length === 1) gesture = { x: ps[0].x, y: ps[0].y, tx, ty, moved: false };
    if (ps.length >= 2) {
      const [a, b] = ps;
      gesture = {
        cx: (a.x + b.x) / 2 - r.left,
        cy: (a.y + b.y) / 2 - r.top,
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        tx,
        ty,
        moved: true,
      };
      suppressClick = true;
    }
  }
  map.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.map-tools,.map-bottom')) return;
    if (!pointers.size) suppressClick = false;
    map.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.target.setPointerCapture(e.pointerId);
    if (pointers.size >= 2) {
      // Keep both touch captures on the map throughout a pinch gesture.
      for (const id of pointers.keys()) map.setPointerCapture(id);
    }
    startGesture();
  });
  map.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...pointers.values()];
    if (ps.length === 1) {
      const dx = e.clientX - gesture.x,
        dy = e.clientY - gesture.y;
      if (Math.hypot(dx, dy) > 4) gesture.moved = true;
      tx = gesture.tx + dx;
      ty = gesture.ty + dy;
    } else {
      const [a, b] = ps,
        r = map.getBoundingClientRect(),
        distance = Math.hypot(a.x - b.x, a.y - b.y),
        cx = (a.x + b.x) / 2 - r.left,
        cy = (a.y + b.y) / 2 - r.top;
      scale = Math.min(
        8,
        Math.max(0.1, (gesture.scale * distance) / Math.max(gesture.distance, 1)),
      );
      const ratio = scale / gesture.scale;
      tx = cx - (gesture.cx - gesture.tx) * ratio;
      ty = cy - (gesture.cy - gesture.ty) * ratio;
    }
    if (gesture.moved) {
      map.classList.add('dragging');
      suppressClick = true;
    }
    scheduleMap();
  });
  function finishPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size) startGesture();
    else {
      gesture = null;
      map.classList.remove('dragging');
    }
  }
  map.addEventListener('pointerup', finishPointer);
  map.addEventListener('pointercancel', finishPointer);
  map.addEventListener('lostpointercapture', (e) => {
    if (!map.hasPointerCapture(e.pointerId)) finishPointer(e);
  });
  map.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    const r = map.getBoundingClientRect();
    zoom(1.5, e.clientX - r.left, e.clientY - r.top);
  });
  document.addEventListener('keydown', (e) => {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target.closest('input,textarea,select,[contenteditable]') ||
      document.querySelector('dialog[open]')
    )
      return;
    if (e.key === 'Escape') {
      closeSidebar();
      return;
    }
    if (!map.contains(e.target)) return;
    const actions = {
      '+': () => zoom(1.3),
      '=': () => zoom(1.3),
      '-': () => zoom(1 / 1.3),
      0: fitMap,
      ArrowLeft: () => {
        tx += 80;
      },
      ArrowRight: () => {
        tx -= 80;
      },
      ArrowUp: () => {
        ty += 80;
      },
      ArrowDown: () => {
        ty -= 80;
      },
    };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
      scheduleMap();
    }
  });
  function backupObject() {
    return {
      app: 'fh3-local-map',
      version: 1,
      exportedAt: new Date().toISOString(),
      source: window.FH3_DATA.source,
      total: points.length,
      collected: [...collected].sort((a, b) => a - b),
    };
  }
  function openBackup(mode) {
    backupMode = mode;
    $('backup-title').textContent = mode === 'export' ? '导出收集进度' : '导入收集进度';
    $('backup-intro').textContent =
      mode === 'export'
        ? '下载备份后，可在其他浏览器或电脑上导入。当前已收集 ' +
          collected.size +
          ' / ' +
          points.length +
          '。'
        : '选择之前导出的 JSON 文件，或粘贴备份内容。导入前会校验全部编号。';
    $('import-file-row').hidden = mode !== 'import';
    $('replace-row').hidden = mode !== 'import';
    $('replace-progress').checked = false;
    $('backup-content').readOnly = mode === 'export';
    $('backup-content').value = mode === 'export' ? JSON.stringify(backupObject(), null, 2) : '';
    $('backup-content').placeholder = mode === 'import' ? '粘贴 FH3 收集地图导出的 JSON 备份…' : '';
    $('backup-submit').textContent = mode === 'export' ? '下载 JSON 备份' : '合并进度';
    $('backup-error').hidden = true;
    $('import-file').value = '';
    $('backup-dialog').showModal();
  }
  $('export-button').addEventListener('click', () => openBackup('export'));
  $('import-button').addEventListener('click', () => openBackup('import'));
  $('close-backup').addEventListener('click', () => $('backup-dialog').close());
  $('cancel-backup').addEventListener('click', () => $('backup-dialog').close());
  $('replace-progress').addEventListener('change', () => {
    $('backup-submit').textContent = $('replace-progress').checked ? '替换进度' : '合并进度';
  });
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      backupError('文件过大，请选择本地图导出的 JSON 备份（最大 1 MB）。');
      return;
    }
    try {
      $('backup-content').value = await file.text();
      $('backup-error').hidden = true;
    } catch {
      backupError('文件读取失败，请重试或粘贴内容。');
    }
  });
  function backupError(message) {
    $('backup-error').textContent = message;
    $('backup-error').hidden = false;
  }
  $('backup-submit').addEventListener('click', () => {
    if (backupMode === 'export') {
      const blob = new Blob([$('backup-content').value], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = 'FH3-收集进度-' + new Date().toISOString().slice(0, 10) + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return;
    }
    let data;
    try {
      if ($('backup-content').value.length > 1024 * 1024) throw new Error('备份内容过大。');
      data = JSON.parse($('backup-content').value);
      if (
        !data ||
        data.app !== 'fh3-local-map' ||
        data.version !== 1 ||
        !Array.isArray(data.collected)
      )
        throw new Error('备份格式不匹配。请选择 FH3 收集地图导出的版本 1 备份。');
      if (
        data.collected.length > points.length ||
        new Set(data.collected).size !== data.collected.length ||
        data.collected.some((id) => !Number.isInteger(id) || !byId.has(id))
      )
        throw new Error('备份包含重复或无效的要素编号，未导入任何进度。');
    } catch (e) {
      backupError(e instanceof SyntaxError ? 'JSON 格式无效，请粘贴完整备份内容。' : e.message);
      return;
    }
    const replace = $('replace-progress').checked;
    let changes;
    try {
      changes = progress.import(data.collected, replace);
    } catch (error) {
      loadProgress();
      render();
      updateSaveStatus(false);
      backupError(
        error.restored === false
          ? '浏览器存储异常，无法完整恢复。请先导出当前进度并检查存储设置。'
          : '保存失败，已恢复原进度。请检查浏览器存储后重试。',
      );
      return;
    }
    loadProgress();
    updateSaveStatus(true);
    undo = changes;
    render();
    $('backup-dialog').close();
    notify(
      '已' + (replace ? '替换' : '合并') + '备份，更新 ' + changes.size + ' 个标记',
      changes.size > 0,
    );
  });
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key.startsWith(PREFIX)) {
      loadProgress();
      render();
    }
  });
  window.addEventListener('focus', () => {
    loadProgress();
    render();
  });
  new ResizeObserver(() => {
    const size = [map.clientWidth, map.clientHeight];
    if (!lastMapSize) {
      lastMapSize = size;
      return;
    }
    tx += (size[0] - lastMapSize[0]) / 2;
    ty += (size[1] - lastMapSize[1]) / 2;
    lastMapSize = size;
    scheduleMap();
  }).observe(map);
  loadProgress();
  tiles.show(region);
  buildCategories();
  fitMap();
  zoom(innerWidth > 760 ? 1.8 : 1.4);
  render();
})();
