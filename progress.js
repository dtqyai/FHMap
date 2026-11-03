/* Preserve legacy per-point values; revisions protect undo across tabs. */
window.FH3Progress = (() => {
  'use strict';
  const prefix = 'fh3.collect.v1.',
    revisionPrefix = 'fh3.collect.revision.v1.';
  function create(ids, getStorage = () => localStorage, game = 'fh3') {
    const prefix = game + '.collect.v1.',
      revisionPrefix = game + '.collect.revision.v1.';
    const valid = new Set(ids),
      writer = globalThis.crypto?.randomUUID?.() || Date.now() + ':' + Math.random();
    let sequence = 0;
    function read() {
      const storage = getStorage();
      return new Set(ids.filter((id) => storage.getItem(prefix + id) === '1'));
    }
    function change(storage, id, before, after) {
      return {
        before,
        after,
        beforeRevision: storage.getItem(revisionPrefix + id),
        afterRevision: writer + ':' + ++sequence,
      };
    }
    function commit(changes) {
      const storage = getStorage(),
        written = [];
      function write(key, before, after) {
        if (after === null) storage.removeItem(key);
        else storage.setItem(key, after);
        written.push({ key, before, after });
      }
      try {
        for (const [id, item] of changes) {
          // Invalidate older undo records before changing the legacy value.
          write(revisionPrefix + id, item.beforeRevision, item.afterRevision);
          write(prefix + id, item.before, item.after);
        }
      } catch (cause) {
        let restored = true;
        for (const { key, before, after } of written.reverse()) {
          try {
            if (storage.getItem(key) !== after) {
              restored = false;
              continue;
            }
            if (before === null) storage.removeItem(key);
            else storage.setItem(key, before);
          } catch {
            restored = false;
          }
        }
        const error = new Error('Progress could not be saved', { cause });
        error.restored = restored;
        throw error;
      }
      return changes;
    }
    function set(id, value) {
      if (!valid.has(id)) throw new Error('Invalid point ID');
      const storage = getStorage(),
        before = storage.getItem(prefix + id);
      return commit(new Map([[id, change(storage, id, before, value ? '1' : '0')]]));
    }
    function importProgress(incoming, replace = false) {
      if (
        !Array.isArray(incoming) ||
        incoming.length > ids.length ||
        new Set(incoming).size !== incoming.length ||
        incoming.some((id) => !Number.isInteger(id) || !valid.has(id))
      )
        throw new Error('Invalid point IDs');
      const selected = new Set(incoming),
        storage = getStorage(),
        changes = new Map();
      for (const id of ids) {
        const before = storage.getItem(prefix + id);
        const next = selected.has(id) || (!replace && before === '1');
        if (next !== (before === '1'))
          changes.set(id, change(storage, id, before, next ? '1' : '0'));
      }
      return commit(changes);
    }
    function undo(previous) {
      const storage = getStorage(),
        changes = new Map();
      for (const [id, item] of previous) {
        if (
          storage.getItem(prefix + id) === item.after &&
          storage.getItem(revisionPrefix + id) === item.afterRevision
        )
          changes.set(id, change(storage, id, item.after, item.before));
      }
      return commit(changes);
    }
    return { prefix, revisionPrefix, read, set, import: importProgress, undo };
  }
  return { prefix, revisionPrefix, create };
})();
