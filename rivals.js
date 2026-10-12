// Win-rate lines for the rivals chart, computed from saved games.
const { nameKey } = require('./players');

const SHOW = 6, WINDOW = 100, FIRST_POINT = 3;

// Keys of a Map<key, {n, last}> ordered by n desc, then most recent game desc.
const ranked = (m, field) => [...m.entries()].sort((x, y) => y[1][field] - x[1][field] || y[1].last - x[1].last).map(([k]) => k);

// One entry per captain per game: two players sharing a name (e.g. two default "Player"s) count once,
// as a win if either of them won.
function captains(g) {
  const byKey = new Map();
  for (const p of g.players) { const c = byKey.get(p.key); byKey.set(p.key, c ? { ...p, won: c.won || p.won } : p); }
  return [...byKey.values()];
}

function computeRivals(games, name) {
  const me = nameKey(name) || null;
  const list = games.slice().sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .map(g => ({ completedAt: g.completedAt, players: captains(g) }));

  // Who played how much, and with me
  const seen = new Map(), shared = new Map();
  list.forEach((g, i) => {
    const keys = g.players.map(p => p.key);
    for (const k of keys) { const s = seen.get(k) || { played: 0, last: -1 }; s.played++; s.last = i; seen.set(k, s); }
    if (me && keys.includes(me)) for (const k of keys) if (k !== me) { const s = shared.get(k) || { n: 0, last: -1 }; s.n++; s.last = i; shared.set(k, s); }
  });
  const rivalsMode = Boolean(me && seen.has(me));
  const keys = rivalsMode ? [me, ...ranked(shared, 'n').slice(0, SHOW - 1)] : ranked(seen, 'played').slice(0, SHOW);
  const shown = new Set(keys);

  // The x-axis: newest WINDOW games involving anyone shown
  const timeline = list.map((g, i) => g.players.some(p => shown.has(p.key)) ? i : -1).filter(i => i >= 0);
  const windowed = timeline.slice(-WINDOW), pos = new Map(windowed.map((gi, w) => [gi, w]));

  // Running totals over all history; points only inside the window, from the FIRST_POINT-th game
  const stats = new Map(keys.map(k => [k, { key: k, name: '', hull: 'navy', played: 0, won: 0, points: [] }]));
  list.forEach((g, i) => {
    for (const p of g.players) {
      const s = stats.get(p.key);
      if (!s) continue;
      s.played++; if (p.won) s.won++;
      s.name = p.name; s.hull = p.hull;
      if (pos.has(i) && s.played >= FIRST_POINT) s.points.push([pos.get(i), Math.round(s.won / s.played * 1000) / 1000]);
    }
  });

  const rate = s => s.won / s.played;
  const players = [...stats.values()].filter(s => s.played > 0)
    .sort((a, b) => rate(b) - rate(a) || b.played - a.played || a.key.localeCompare(b.key));
  return { mode: rivalsMode ? 'rivals' : 'active', me, games: windowed.map(i => list[i].completedAt), players };
}

module.exports = { computeRivals, SHOW, WINDOW, FIRST_POINT };
