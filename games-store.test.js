const a = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createGamesStore, KEEP } = require('./games-store');
const { nameKey } = require('./players');

const quiet = () => { const errors = []; return { errors, log() {}, error: (...m) => errors.push(m.join(' ')) }; };
const at = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const game = (i, ...players) => ({ completedAt: at(i), players: players.map(([name, won, hull = 'navy', score = won ? 200 : 50]) => ({ name, score, won, hull })) });

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-games-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const tests = {
  async 'nameKey trims, collapses spaces and lowercases'() {
    a.equal(nameKey('  Anna   Bell '), 'anna bell');
    a.equal(nameKey('ANNA'), nameKey(' anna'));
    a.equal(nameKey(undefined), '');
  },
  async 'empty store lists nothing'() {
    await withDir(async dir => {
      const s = createGamesStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      a.deepEqual(s.list(), []);
    });
  },
  async 'recorded games survive a restart, oldest first, with keys and hulls'() {
    await withDir(async dir => {
      const s = createGamesStore({ dataDir: dir, logger: quiet() });
      await s.record(game(2, ['Bo', true, 'mango'], ['Anna ', false, 'coral']));
      await s.record(game(1, ['Anna', true, 'coral'], ['Bo', false, 'mango']));
      const again = createGamesStore({ dataDir: dir, logger: quiet() });
      await again.ready;
      const list = again.list();
      a.deepEqual(list.map(g => g.completedAt), [at(1), at(2)]);
      a.deepEqual(list[1].players.map(p => [p.key, p.won, p.hull]), [['bo', true, 'mango'], ['anna', false, 'coral']]);
    });
  },
  async 'keeps only the newest 5000 games'() {
    await withDir(async dir => {
      const rows = Array.from({ length: KEEP + 1 }, (_, i) => game(i, ['A', true], ['B', false]));
      await fs.writeFile(path.join(dir, 'games.json'), JSON.stringify(rows));
      const s = createGamesStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      const list = s.list();
      a.equal(list.length, KEEP);
      a.equal(list[0].completedAt, at(1)); // game 0 dropped
    });
  },
  async 'malformed games are discarded, bad hulls become navy, names stay literal'() {
    await withDir(async dir => {
      const log = quiet();
      const rows = [
        game(1, ['A', true]),                                   // only one player
        { completedAt: 'not a date', players: game(2, ['A', true], ['B', false]).players },
        game(3, ['A', 'yes'], ['B', false]),                    // won is not a boolean
        game(4, ["<b>O'Neil</b>", true, 'red;x'], ['B', false]),
      ];
      await fs.writeFile(path.join(dir, 'games.json'), JSON.stringify(rows));
      const s = createGamesStore({ dataDir: dir, logger: log });
      await s.ready;
      const list = s.list();
      a.equal(list.length, 1);
      a.equal(list[0].players[0].name, "<b>O'Neil</b>");
      a.equal(list[0].players[0].hull, 'navy');
      a.ok(log.errors.length >= 3);
    });
  },
  async 'unreadable storage lists empty and rejects writes'() {
    await withDir(async dir => {
      await fs.mkdir(path.join(dir, 'games.json'));
      const log = quiet();
      const s = createGamesStore({ dataDir: dir, logger: log });
      await s.ready;
      a.equal(s.available, false);
      a.deepEqual(s.list(), []);
      await a.rejects(s.record(game(1, ['A', true], ['B', false])));
      a.ok(log.errors.length > 0);
    });
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
