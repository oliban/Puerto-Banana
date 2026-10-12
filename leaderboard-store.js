// Durable top-20 leaderboard on a shared JSON-file store.
const { createJsonFileStore } = require('./json-file-store');

const FILE = 'highscores.json', LIMIT = 20, NAME_MAX = 20;

const rank = (a, b) => b.score - a.score || Date.parse(a.completedAt) - Date.parse(b.completedAt);

// A clean public record, or null if the row is not one.
function clean(e) {
  if (!e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.completedAt !== 'string') return null;
  if (!Number.isSafeInteger(e.score) || e.score < 0 || Number.isNaN(Date.parse(e.completedAt))) return null;
  return { name: e.name.slice(0, NAME_MAX), score: e.score, completedAt: new Date(e.completedAt).toISOString() };
}

function createLeaderboardStore({ dataDir = process.env.DATA_DIR || '/data', logger = console } = {}) {
  const top = rows => rows.slice().sort(rank).slice(0, LIMIT);
  const base = createJsonFileStore({ dataDir, file: FILE, label: 'highscores', clean, normalize: top, logger,
    unavailableMessage: 'Highscore storage is unavailable.' });
  return {
    get available() { return base.available; },
    logger,
    ready: base.ready,
    list: () => base.rows().map(e => ({ ...e })),
    record: newEntries => base.update(rows => rows.concat(base.accept(newEntries, 'new'))),
  };
}

module.exports = { createLeaderboardStore };
