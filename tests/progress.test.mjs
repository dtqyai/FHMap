import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = { window: {} };
runInNewContext(readFileSync(new URL('../progress.js', import.meta.url), 'utf8'), context);
const { prefix, create } = context.window.FH3Progress;
function fixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  let fail = null;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (fail?.(key, value)) throw new Error('Quota exceeded');
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  return { values, store: create([1, 2, 3], () => storage), failWhen: (fn) => (fail = fn) };
}
test('reads old per-point keys and persists individual changes', () => {
  const { store, values } = fixture({ [prefix + 1]: '1', [prefix + 2]: '0' });
  assert.deepEqual([...store.read()], [1]);
  store.set(2, true);
  store.set(1, false);
  assert.deepEqual([...store.read()], [2]);
  assert.equal(values.get(prefix + 1), '0');
});
test('merge preserves current progress; replace removes only absent IDs', () => {
  const { store } = fixture({ [prefix + 1]: '1' });
  store.import([2]);
  assert.deepEqual([...store.read()], [1, 2]);
  store.import([3], true);
  assert.deepEqual([...store.read()], [3]);
});
test('rollback restores raw missing keys after a partial quota failure', () => {
  const { store, values, failWhen } = fixture({ [prefix + 1]: '1' });
  let failed = false;
  failWhen((key) => key === prefix + 3 && !failed && (failed = true));
  assert.throws(
    () => store.import([2, 3], true),
    (e) => e.restored === true,
  );
  assert.deepEqual([...values], [[prefix + 1, '1']]);
});
test('reports when rollback itself fails', () => {
  const { store, failWhen } = fixture({ [prefix + 1]: '1' });
  let failed = false;
  failWhen((key, value) => {
    if (key === prefix + 3) {
      failed = true;
      return true;
    }
    return failed && key === prefix + 1 && value === '1';
  });
  assert.throws(
    () => store.import([2, 3], true),
    (e) => e.restored === false,
  );
});
test('undo restores raw values and respects subsequent edits from other tabs', () => {
  const { store, values } = fixture({ [prefix + 1]: '1' });
  const changes = store.import([2, 3], true);
  values.set(prefix + 2, '0'); // another tab changed this point after import
  store.undo(changes);
  assert.equal(values.get(prefix + 1), '1');
  assert.equal(values.get(prefix + 2), '0');
  assert.equal(values.has(prefix + 3), false);
});
test('invalid and duplicate IDs never write storage', () => {
  const { store, values } = fixture();
  for (const ids of [[1, 1], [145], ['1'], [1, 2, 3, 4]]) assert.throws(() => store.import(ids));
  assert.equal(values.size, 0);
});
test('read failure does not turn a merge into a replacement', () => {
  const store = create([1, 2], () => ({
    getItem() {
      throw new Error('Denied');
    },
  }));
  assert.throws(() => store.import([2]));
});
