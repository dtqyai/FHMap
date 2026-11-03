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

runInNewContext(readFileSync(new URL('games.js', root), 'utf8'), context);
const snapshot = JSON.parse(readFileSync(new URL('source/mapgenie.json', root), 'utf8'));
assert.equal(snapshot.maps.length, 6);
assert.deepEqual(Object.keys(context.window.FH_GAMES), ['fh3', 'fh4', 'fh5']);
let addedPoints = 0,
  addedTiles = 0,
  addedBytes = 0;
for (const gameId of ['fh4', 'fh5']) {
  const game = context.window.FH_GAMES[gameId],
    ids = new Set(game.data.points.map((point) => point[0]));
  assert.equal(Object.keys(game.maps).length, 3);
  assert.equal(ids.size, game.data.points.length, 'Duplicate source point IDs in ' + gameId);
  for (const record of snapshot.maps.filter((map) => map.game === gameId)) {
    const region = gameId + '-' + record.slug,
      config = game.maps[region],
      points = game.data.points.filter((point) => game.data.types[point[1]].region === region),
      originals = new Map(record.locations.map((point) => [point.id, point]));
    assert.equal(points.length, record.locations.length, region + ' point count');
    assert.equal(config.source, record.url);
    const world = 256 * 2 ** config.sourceZoom;
    for (const [id, type, x, y] of points) {
      const original = originals.get(id);
      assert.ok(original, 'Unknown MapGenie ID ' + id);
      assert.equal(type, record.map.id * 100000 + original.category_id);
      const projectedX = ((original.longitude + 180) / 360) * world - config.sourceOrigin[0],
        projectedY =
          ((1 - Math.asinh(Math.tan((original.latitude * Math.PI) / 180)) / Math.PI) / 2) * world -
          config.sourceOrigin[1];
      assert.ok(
        Math.abs(x - projectedX) < 0.001 && Math.abs(y - projectedY) < 0.001,
        'Projection ' + id,
      );
      assert.ok(
        x >= 0 && x <= config.width && y >= 0 && y <= config.height,
        'Point outside map ' + id,
      );
    }
    for (const [type, category] of Object.entries(game.data.types).filter(
      ([, category]) => category.region === region,
    ))
      assert.equal(points.filter((point) => point[1] === Number(type)).length, category.total);
    for (const level of config.tiles.levels) {
      assert.equal(level.cols, Math.ceil(level.width / config.tiles.size));
      assert.equal(level.rows, Math.ceil(level.height / config.tiles.size));
      for (let y = 0; y < level.rows; y++)
        for (let x = 0; x < level.cols; x++) {
          const file = new URL(
              config.tiles.base + '/' + level.z + '/' + x + '-' + y + '.webp',
              root,
            ),
            size = statSync(file).size;
          assert.ok(size > 0 && size < 200000, 'Unexpected MapGenie tile size');
          addedTiles++;
          addedBytes += size;
        }
    }
    addedPoints += points.length;
  }
}
console.log(
  `PASS: six MapGenie maps, ${addedPoints} source IDs and projected coordinates; ${addedTiles} WebP tiles, ${addedBytes} bytes.`,
);
