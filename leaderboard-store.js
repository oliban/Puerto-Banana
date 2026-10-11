// Durable top-20 leaderboard: one JSON file, serialized atomic writes (temp file + rename).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FILE = 'highscores.json', LIMIT = 20, NAME_MAX = 20;

const rank = (a, b) => b.score - a.score || Date.parse(a.completedAt) - Date.parse(b.completedAt);

// A clean public record, or null if the row is not one.
function clean(e) {
  if (!e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.completedAt !== 'string') return null;
  if (!Number.isSafeInteger(e.score) || e.score < 0 || Number.isNaN(Date.parse(e.completedAt))) return null;
  return { name: e.name.slice(0, NAME_MAX), score: e.score, completedAt: new Date(e.completedAt).toISOString() };
}

function createLeaderboardStore({ dataDir = process.env.DATA_DIR || '/data', logger = console } = {}) {
  const file = path.join(dataDir, FILE);
  let entries = [];
  let chain = Promise.resolve();
  const store = { available: true, logger };

  const accept = (rows, source) => {
    const good = [];
    for (const r of rows) { const c = clean(r); if (c) good.push(c); else logger.error(`[highscores] discarded malformed ${source} row:`, JSON.stringify(r)); }
    return good;
  };

  store.ready = (async () => {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return;
      store.available = false;
      logger.error(`[highscores] storage unavailable (${file}):`, e.message);
      return;
    }
    try {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error('not an array');
      entries = accept(rows, 'stored').sort(rank).slice(0, LIMIT);
    } catch (e) {
      logger.error(`[highscores] ${file} is corrupt (${e.message}); starting empty, next save replaces it`);
    }
  })();

  store.list = () => entries.map(e => ({ ...e }));

  store.record = newEntries => {
    const run = chain.then(async () => {
      await store.ready;
      if (!store.available) throw new Error('Highscore storage is unavailable.');
      const next = entries.concat(accept(newEntries, 'new')).sort(rank).slice(0, LIMIT);
      const tmp = path.join(dataDir, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(next, null, 1));
        await fs.rename(tmp, file);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        logger.error('[highscores] save failed:', e.message);
        throw e;
      }
      entries = next;
    });
    chain = run.catch(() => {}); // a failed write must not block later ones
    return run;
  };

  return store;
}

module.exports = { createLeaderboardStore };
