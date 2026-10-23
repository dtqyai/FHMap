/* Progress storage. Preserve the original per-point keys and roll back raw values. */
window.FH3Progress = (() => {
  'use strict';
  const prefix = 'fh3.collect.v1.';
  function create(ids, getStorage = () => localStorage) {
    const valid = new Set(ids);
    function read() {
      const storage = getStorage();
      return new Set(ids.filter((id) => storage.getItem(prefix + id) === '1'));
    }
    function set(id, value) {
      if (!valid.has(id)) throw new Error('Invalid point ID');
      getStorage().setItem(prefix + id, value ? '1' : '0');
    }
    function commit(changes) {
      const storage = getStorage(),
        written = [];
      try {
        for (const [id, change] of changes) {
          if (change.after === null) storage.removeItem(prefix + id);
          else storage.setItem(prefix + id, change.after);
          written.push([id, change]);
        }
      } catch (cause) {
        let restored = true;
        for (const [id, change] of written.reverse()) {
          try {
            if (change.before === null) storage.removeItem(prefix + id);
            else storage.setItem(prefix + id, change.before);
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
        if (next !== (before === '1')) changes.set(id, { before, after: next ? '1' : '0' });
      }
      return commit(changes);
    }
    function undo(previous) {
      const storage = getStorage(),
        changes = new Map();
      for (const [id, change] of previous) {
        // Leave edits made by another tab after the import alone.
        if (storage.getItem(prefix + id) === change.after)
          changes.set(id, { before: change.after, after: change.before });
      }
      return commit(changes);
    }
    return { read, set, import: importProgress, undo };
  }
  return { prefix, create };
})();
