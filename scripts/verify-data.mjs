import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
const root = new URL('../', import.meta.url),
  context = { window: {} };
runInNewContext(readFileSync(new URL('data.js', root), 'utf8'), context);
const data = context.window.FH3_DATA,
  source = JSON.parse(readFileSync(new URL('source/extracted-points.json', root), 'utf8'));
assert.equal(data.points.length, 235);
assert.equal(source.markers.length, 235);
assert.equal(new Set(data.points.map((p) => p[0])).size, 235);
assert.equal(data.width, source.image.width);
assert.equal(data.height, source.image.height);
const originals = new Map(source.markers.map((m) => [Number(m.id), m]));
const counts = {};
for (const [id, type, x, y, hint] of data.points) {
  const m = originals.get(id);
  assert.ok(m, 'Unknown source ID ' + id);
  assert.equal(type, Number(m.type), 'Type ' + id);
  assert.equal(x, parseFloat(m.left) + m.width / 2, 'X ' + id);
  assert.equal(y, parseFloat(m.top) + m.height / 2, 'Y ' + id);
  assert.equal(hint, m.hint, 'Hint ' + id);
  assert.ok(x >= 0 && x <= data.width && y >= 0 && y <= data.height, 'Out of bounds ' + id);
  counts[type] = (counts[type] || 0) + 1;
}
for (const [id, type] of Object.entries(data.types))
  assert.equal(counts[id], type.total, 'Total for type ' + id);
for (const name of [
  'index.html',
  'app.js',
  'tiles.js',
  'progress.js',
  'style.css',
  'data.js',
  'source/reference/fh3-map.jpg',
])
  assert.ok(readFileSync(new URL(name, root)).length, 'Missing ' + name);
console.log('PASS: 235 unique IDs, all categories and coordinates match the observed source.');
console.log('Counts:', counts);
runInNewContext(readFileSync(new URL('maps.js', root), 'utf8'), context);
const calibration = JSON.parse(readFileSync(new URL('source/map-calibration.json', root), 'utf8'));
const requireSourceImages = process.argv.includes('--source-images');
let checkedSourceImages = 0;
let totalTiles = 0,
  totalBytes = 0,
  largestTile = 0;
for (const [key, map] of Object.entries(context.window.FH3_MAPS)) {
  assert.equal(map.sourceImage, calibration[key].image);
  assert.equal(JSON.stringify(map.oldToImage), JSON.stringify(calibration[key].oldToImage));
  assert.equal(map.width, calibration[key].width);
  assert.equal(map.height, calibration[key].height);
  const sourceImage = new URL('source/originals/' + map.sourceImage, root);
  if (existsSync(sourceImage)) {
    const header = Buffer.alloc(24),
      fd = openSync(sourceImage, 'r');
    try {
      assert.equal(readSync(fd, header, 0, 24, 0), 24);
    } finally {
      closeSync(fd);
    }
    assert.equal(header.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(header.readUInt32BE(16), map.width);
    assert.equal(header.readUInt32BE(20), map.height);
    checkedSourceImages++;
  } else assert.ok(!requireSourceImages, 'Missing original source image: ' + map.sourceImage);
  assert.ok(calibration[key].inliers > 100);
  assert.ok(calibration[key].p95ErrorInImagePixels < 5);
  const [cx, cy, cw, ch] = map.crop;
  if (map.referenceCrop) {
    const [rx, ry, rw, rh] = map.referenceCrop,
      s = 1 / map.unit;
    assert.equal(key, 'blizzard');
    assert.equal(
      JSON.stringify(map.oldToMap),
      JSON.stringify([
        [s, 0, -rx * s],
        [0, s, -ry * s],
      ]),
      'Reference orientation must have no rotation or shear',
    );
    assert.equal(cx, 0);
    assert.equal(cy, 0);
    assert.equal(cw, Math.ceil(rw * s));
    assert.equal(ch, Math.ceil(rh * s));
  }
  if (key === 'blizzard')
    assert.ok(
      map.referenceCrop && map.oldToMap,
      'Blizzard must retain the reference map orientation',
    );
  for (const [id, type, x, y] of data.points.filter((p) => data.types[p[1]].region === key)) {
    const [a, b] = map.oldToMap || map.oldToImage,
      px = a[0] * x + a[1] * y + a[2],
      py = b[0] * x + b[1] * y + b[2];
    assert.ok(
      px >= cx && px <= cx + cw && py >= cy && py <= cy + ch,
      'Calibrated point outside crop: ' + id,
    );
  }
  for (const level of map.tiles.levels)
    for (let y = 0; y < level.rows; y++)
      for (let x = 0; x < level.cols; x++) {
        const size = statSync(
          new URL(map.tiles.base + '/' + level.z + '/' + x + '-' + y + '.webp', root),
        ).size;
        assert.ok(size > 0 && size < 200000, 'Unexpected tile size');
        totalTiles++;
        totalBytes += size;
        largestTile = Math.max(size, largestTile);
      }
}
console.log(
  'PASS: three calibrated image pyramids; ' +
    totalTiles +
    ' tiles, ' +
    totalBytes +
    ' bytes total, ' +
    largestTile +
    ' bytes largest tile.',
);
console.log(
  'Source PNG headers checked: ' +
    checkedSourceImages +
    ' / 3' +
    (checkedSourceImages < 3 ? ' (optional; source/originals/ is not versioned)' : ''),
);

// FH2 keeps the saved KudosPrime IDs, including the three Fast & Furious categories.
runInNewContext(readFileSync(new URL('data-fh2.js', root), 'utf8'), context);
runInNewContext(readFileSync(new URL('maps-fh2.js', root), 'utf8'), context);
runInNewContext(readFileSync(new URL('games.js', root), 'utf8'), context);
const fh2 = context.window.FH2_DATA,
  fh2Maps = context.window.FH2_MAPS,
  fh2Source = JSON.parse(readFileSync(new URL('source/fh2-extracted-points.json', root))),
  storm = JSON.parse(readFileSync(new URL('source/fh2-storm-points.json', root))),
  fh2Cal = JSON.parse(readFileSync(new URL('source/fh2-map-calibration.json', root)));
assert.deepEqual(Object.keys(context.window.FH_GAMES), ['fh2', 'fh3']);
assert.equal(fh2Source.markers.length, 240);
assert.equal(storm.boards.length, 25);
assert.equal(fh2.points.length, 266);
assert.ok(storm.barn.inliers > 100);
assert.ok(storm.barn.p95Residual < 3);
assert.equal(new Set(fh2.points.map((p) => p[0])).size, fh2.points.length);
const fh2ById = new Map(fh2.points.map((p) => [p[0], p]));
for (const p of fh2Source.markers) {
  const actual = fh2ById.get(p.id);
  assert.ok(actual, 'Missing KudosPrime FH2 ID ' + p.id);
  assert.equal(actual[1], p.type);
  assert.equal(actual[2], p.left + p.width / 2);
  assert.equal(actual[3], p.top + p.height / 2);
}
for (const p of storm.boards) {
  const actual = fh2ById.get(p.id);
  assert.equal(actual[1], 20);
  assert.equal(actual[2], p.x);
  assert.equal(actual[3], p.y);
}
if (storm.barn) {
  const actual = fh2ById.get(storm.barn.id);
  assert.equal(actual[1], 21);
  assert.equal(actual[2], storm.barn.x);
  assert.equal(actual[3], storm.barn.y);
}
for (const [type, item] of Object.entries(fh2.types)) {
  assert.equal(fh2.points.filter((p) => p[1] === Number(type)).length, item.total);
}
let fh2Tiles = 0,
  fh2Bytes = 0,
  fh2Largest = 0;
for (const [key, config] of Object.entries(fh2Maps)) {
  const cal = fh2Cal[key];
  assert.equal(JSON.stringify(config.oldToImage), JSON.stringify(cal.oldToImage));
  assert.ok(cal.inliers > 1000);
  assert.ok(cal.p95Residual < 5);
  const sourceImage = new URL('source/originals/' + config.sourceImage, root);
  if (existsSync(sourceImage)) {
    const header = Buffer.alloc(24),
      fd = openSync(sourceImage, 'r');
    try {
      assert.equal(readSync(fd, header, 0, 24, 0), 24);
    } finally {
      closeSync(fd);
    }
    assert.equal(header.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(header.readUInt32BE(16), config.width);
    assert.equal(header.readUInt32BE(20), config.height);
  } else assert.ok(!requireSourceImages, 'Missing original source image: ' + config.sourceImage);
  const [cx, cy, cw, ch] = config.crop,
    [a, b] = config.oldToImage;
  for (const [id, type, x, y] of fh2.points) {
    if (fh2.types[type].region !== key) continue;
    const px = a[0] * x + a[1] * y + a[2],
      py = b[0] * x + b[1] * y + b[2];
    assert.ok(Number.isFinite(px) && Number.isFinite(py));
    assert.ok(
      px >= cx && px <= cx + cw && py >= cy && py <= cy + ch,
      'FH2 point outside map crop: ' + id,
    );
  }
  for (const level of config.tiles.levels)
    for (let y = 0; y < level.rows; y++)
      for (let x = 0; x < level.cols; x++) {
        const size = statSync(
          new URL(config.tiles.base + '/' + level.z + '/' + x + '-' + y + '.webp', root),
        ).size;
        assert.ok(size > 0 && size < 200000);
        fh2Tiles++;
        fh2Bytes += size;
        fh2Largest = Math.max(size, fh2Largest);
      }
}
console.log(
  `PASS: FH2 ${fh2.points.length} unique points, two calibrated maps; ${fh2Tiles} tiles, ${fh2Bytes} bytes, largest ${fh2Largest} bytes.`,
);
