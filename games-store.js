// Every finished game (newest 5000) for the rivals chart, on the shared JSON-file store.
const { createJsonFileStore } = require('./json-file-store');
const { hullOf, nameKey, NAME_MAX } = require('./players');

const FILE = 'games.json', KEEP = 5000;

function cleanPlayer(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.won !== 'boolean') return null;
  if (!Number.isSafeInteger(p.score) || p.score < 0) return null;
  const name = p.name.slice(0, NAME_MAX), key = nameKey(name);
  if (!key) return null;
  return { name, key, score: p.score, won: p.won, hull: hullOf(p.hull) };
}

// A clean game record, or null if the row is not one.
function clean(g) {
  if (!g || typeof g !== 'object' || typeof g.completedAt !== 'string' || Number.isNaN(Date.parse(g.completedAt))) return null;
  if (!Array.isArray(g.players) || g.players.length < 2) return null;
  const players = g.players.map(cleanPlayer);
  if (players.some(p => !p)) return null;
  return { completedAt: new Date(g.completedAt).toISOString(), players };
}

const byTime = (a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt);

function createGamesStore({ dataDir = process.env.DATA_DIR || '/data', logger = console } = {}) {
  const keep = rows => rows.slice().sort(byTime).slice(-KEEP);
  const base = createJsonFileStore({ dataDir, file: FILE, label: 'games', clean, normalize: keep, logger,
    unavailableMessage: 'Game history storage is unavailable.' });
  return {
    get available() { return base.available; },
    logger,
    ready: base.ready,
    list: () => base.rows().map(g => ({ ...g, players: g.players.map(p => ({ ...p })) })),
    record: game => base.update(rows => rows.concat(base.accept([game], 'new'))),
  };
}

module.exports = { createGamesStore, KEEP };
