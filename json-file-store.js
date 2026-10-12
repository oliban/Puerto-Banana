// One durable JSON-array file: tolerant load, serialized atomic writes (temp file + rename).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// clean(row) -> clean row or null; normalize(rows) -> rows to keep (sorted/capped); runs on load and every write.
function createJsonFileStore({ dataDir, file, label, clean, normalize = rows => rows, logger = console, unavailableMessage }) {
  const full = path.join(dataDir, file);
  let rows = [];
  let chain = Promise.resolve();
  const store = { available: true, logger };

  store.accept = (list, source) => {
    const good = [];
    for (const r of list) { const c = clean(r); if (c) good.push(c); else logger.error(`[${label}] discarded malformed ${source} row:`, JSON.stringify(r)); }
    return good;
  };

  store.ready = (async () => {
    let text;
    try { text = await fs.readFile(full, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return;
      store.available = false;
      logger.error(`[${label}] storage unavailable (${full}):`, e.message);
      return;
    }
    try {
      const list = JSON.parse(text);
      if (!Array.isArray(list)) throw new Error('not an array');
      rows = normalize(store.accept(list, 'stored'));
    } catch (e) {
      logger.error(`[${label}] ${full} is corrupt (${e.message}); starting empty, next save replaces it`);
    }
  })();

  store.rows = () => rows;

  // fn(currentRows) -> nextRows. Writes run one at a time; a failed write keeps the previous rows.
  store.update = fn => {
    const run = chain.then(async () => {
      await store.ready;
      if (!store.available) throw new Error(unavailableMessage);
      const next = normalize(fn(rows));
      const tmp = path.join(dataDir, `.${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(next, null, 1));
        await fs.rename(tmp, full);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        logger.error(`[${label}] save failed:`, e.message);
        throw e;
      }
      rows = next;
    });
    chain = run.catch(() => {}); // a failed write must not block later ones
    return run;
  };

  return store;
}

module.exports = { createJsonFileStore };
