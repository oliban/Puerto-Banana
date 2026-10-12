const a = require('assert/strict');
const { computeRivals, WINDOW } = require('./rivals');
const { nameKey } = require('./players');

const at = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
// game(i, 'Anna+', 'Bo') -> Anna won, Bo lost; hulls optional as 'Anna+:coral'
const game = (i, ...ps) => ({ completedAt: at(i), players: ps.map(s => {
  const [raw, hull = 'navy'] = s.split(':'), won = raw.endsWith('+'), name = won ? raw.slice(0, -1) : raw;
  return { name, key: nameKey(name), score: won ? 200 : 50, won, hull };
}) });
const byKey = (r, k) => r.players.find(p => p.key === k);

const tests = {
  async 'no games: empty fallback, never an error'() {
    a.deepEqual(computeRivals([], 'Anna'), { mode: 'active', me: 'anna', games: [], players: [] });
    a.deepEqual(computeRivals([], ''), { mode: 'active', me: null, games: [], players: [] });
  },
  async 'one line per captain however the name is typed; latest spelling and hull win'() {
    const r = computeRivals([game(1, 'Anna+:coral', 'Bo'), game(2, ' anna :mango', 'Bo+'), game(3, 'ANNA+:palm', 'Bo')], '  aNNa ');
    a.equal(r.mode, 'rivals');
    a.equal(r.me, 'anna');
    const anna = byKey(r, 'anna');
    a.deepEqual([anna.name, anna.hull, anna.played, anna.won], ['ANNA', 'palm', 3, 2]);
  },
  async 'win rate series starts at the 3rd game'() {
    const r = computeRivals([game(1, 'Anna+', 'Bo'), game(2, 'Anna', 'Bo+'), game(3, 'Anna+', 'Bo'), game(4, 'Anna+', 'Bo')], 'Anna');
    a.deepEqual(byKey(r, 'anna').points, [[2, 0.667], [3, 0.75]]);
    a.deepEqual(byKey(r, 'bo').points, [[2, 0.333], [3, 0.25]]);
    a.equal(r.games.length, 4);
    a.deepEqual(r.players.map(p => p.key), ['anna', 'bo']); // highest rate first
  },
  async 'tied winners both count the game as a win'() {
    const r = computeRivals([game(1, 'Anna+', 'Bo+', 'Cy')], 'Anna');
    a.equal(byKey(r, 'anna').won, 1);
    a.equal(byKey(r, 'bo').won, 1);
    a.equal(byKey(r, 'cy').won, 0);
  },
  async 'rivals: me plus the 5 most-shared captains, ties broken by most recent'() {
    const gs = [];
    let i = 0;
    for (const [rival, n] of [['R1', 4], ['R2', 3], ['R3', 3], ['R4', 2], ['R5', 2], ['R6', 1], ['R7', 2]]) for (let k = 0; k < n; k++) gs.push(game(++i, 'Me+', rival));
    gs.push(game(++i, 'Stranger+', 'Other')); // never played with me
    const r = computeRivals(gs, 'me');
    a.equal(r.mode, 'rivals');
    const keys = r.players.map(p => p.key).sort();
    a.deepEqual(keys, ['me', 'r1', 'r2', 'r3', 'r5', 'r7']); // R4 and R7 tie on 2; R7 more recent; R5 more recent than R4
    a.equal(r.games.length, i - 1); // the strangers' game is not on the axis
  },
  async 'unknown or empty name falls back to the 6 most active captains'() {
    const gs = [];
    let i = 0;
    for (const [p, n] of [['A', 5], ['B', 4], ['C', 3], ['D', 3], ['E', 2], ['F', 2], ['G', 1]]) for (let k = 0; k < n; k++) gs.push(game(++i, p + '+', 'Z'));
    for (const name of ['Nobody', '', undefined]) {
      const r = computeRivals(gs, name);
      a.equal(r.mode, 'active');
      a.equal(r.players.length, 6);
      a.ok(!r.players.some(p => p.key === 'g'));
    }
  },
  async 'only the newest 100 games are on the axis, rates count all history'() {
    const gs = Array.from({ length: 130 }, (_, i) => game(i + 1, i < 30 ? 'Anna+' : 'Anna', i < 30 ? 'Bo' : 'Bo+'));
    const r = computeRivals(gs, 'Anna');
    a.equal(r.games.length, WINDOW);
    a.equal(r.games[0], at(31));
    const anna = byKey(r, 'anna');
    a.deepEqual([anna.played, anna.won], [130, 30]);
    a.equal(anna.points.length, 100);
    a.deepEqual(anna.points[0], [0, 0.968]); // 30 of 31 so far
  },
  async 'games saved out of order are charted chronologically'() {
    const r = computeRivals([game(3, 'Anna+', 'Bo'), game(1, 'Anna', 'Bo+'), game(2, 'Anna', 'Bo+')], 'Anna');
    a.deepEqual(r.games, [at(1), at(2), at(3)]);
    a.deepEqual(byKey(r, 'anna').points, [[2, 0.333]]);
  },
  async 'two players with the same name in one game count as one game for that captain'() {
    const r = computeRivals([game(1, 'Player+', 'Player'), game(2, 'Player', 'Player', 'Anna+')], 'player');
    const p = byKey(r, 'player');
    a.deepEqual([p.played, p.won], [2, 1]);
    a.equal(byKey(r, 'anna').played, 1);
  },
  async 'names with quotes or HTML come back literally'() {
    const r = computeRivals([game(1, "<b>O'Neil</b>+", 'Bo')], "<b>O'Neil</b>");
    a.equal(r.players[0].name, "<b>O'Neil</b>");
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
  }
  console.log(failed ? `${failed} failed` : 'all pass');
  process.exit(failed ? 1 : 0);
})();
