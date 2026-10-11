const a = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createLeaderboardStore } = require('./leaderboard-store');

const quiet = () => { const errors = []; return { errors, log() {}, error: (...m) => errors.push(m.join(' ')) }; };
const entry = (name, score, i) => ({ name, score, completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-scores-'));
  try { await fn(dir); } finally { await fs.chmod(dir, 0o700).catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
}

const tests = {
  async 'empty store lists nothing'() {
    await withDir(async dir => {
      const s = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      a.deepEqual(s.list(), []);
    });
  },
  async 'seeded store returns top 20 by score desc then time asc'() {
    await withDir(async dir => {
      const rows = Array.from({ length: 25 }, (_, i) => entry('P' + i, 200 + (i % 5), 25 - i));
      await fs.writeFile(path.join(dir, 'highscores.json'), JSON.stringify(rows));
      const s = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      const out = s.list();
      a.equal(out.length, 20);
      for (let i = 1; i < out.length; i++) {
        const p = out[i - 1], c = out[i];
        a.ok(p.score > c.score || (p.score === c.score && p.completedAt <= c.completedAt), `order at ${i}`);
      }
      a.equal(out[0].score, 204);
      a.equal(out[0].name, 'P24'); // earliest of the 204s
    });
  },
  async 'corrupt JSON logs and starts empty without rejecting ready'() {
    await withDir(async dir => {
      await fs.writeFile(path.join(dir, 'highscores.json'), '{not json');
      const log = quiet();
      const s = createLeaderboardStore({ dataDir: dir, logger: log });
      await s.ready;
      a.deepEqual(s.list(), []);
      a.ok(log.errors.length > 0);
    });
  },
  async 'malformed rows are discarded and names clamped'() {
    await withDir(async dir => {
      const rows = [entry('ok', 210, 1), { name: 'bad', score: -1, completedAt: entry('', 0, 1).completedAt },
        { name: 'x', score: 1.5, completedAt: 'nope' }, { name: 5, score: 10 }, entry('A'.repeat(40), 205, 2), null];
      await fs.writeFile(path.join(dir, 'highscores.json'), JSON.stringify(rows));
      const log = quiet();
      const s = createLeaderboardStore({ dataDir: dir, logger: log });
      await s.ready;
      const out = s.list();
      a.equal(out.length, 2);
      a.equal(out[1].name.length, 20);
      a.ok(log.errors.length > 0);
    });
  },
  async 'HTML-looking names stay literal data'() {
    await withDir(async dir => {
      const s = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      await s.record([entry('<img src=x>', 200, 1)]);
      a.equal(s.list()[0].name, '<img src=x>');
    });
  },
  async 'list returns defensive copies'() {
    await withDir(async dir => {
      const s = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      await s.record([entry('a', 200, 1)]);
      s.list()[0].score = 9999; s.list().push({});
      a.equal(s.list().length, 1);
      a.equal(s.list()[0].score, 200);
    });
  },
  async 'record persists atomically to highscores.json'() {
    await withDir(async dir => {
      const s = createLeaderboardStore({ dataDir: path.join(dir, 'nested'), logger: quiet() });
      await s.ready;
      await s.record([entry('a', 201, 1), entry('b', 201, 1)]);
      const disk = JSON.parse(await fs.readFile(path.join(dir, 'nested', 'highscores.json'), 'utf8'));
      a.equal(disk.length, 2);
      const leftovers = (await fs.readdir(path.join(dir, 'nested'))).filter(f => f !== 'highscores.json');
      a.deepEqual(leftovers, []);
    });
  },
  async 'concurrent records all survive and reload after restart'() {
    await withDir(async dir => {
      const s = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      await Promise.all(Array.from({ length: 10 }, (_, i) => s.record([entry('P' + i, 200 + i, i)])));
      a.equal(s.list().length, 10);
      const s2 = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s2.ready;
      a.deepEqual(s2.list(), s.list());
      a.equal(s2.list()[0].name, 'P9');
    });
  },
  async 'write failure rejects and keeps previous contents'() {
    if (process.getuid && process.getuid() === 0) return; // root ignores permissions
    await withDir(async dir => {
      const s = createLeaderboardStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      await s.record([entry('keep', 200, 1)]);
      await fs.chmod(dir, 0o500);
      await a.rejects(s.record([entry('lost', 300, 2)]));
      a.deepEqual(s.list().map(e => e.name), ['keep']);
      await fs.chmod(dir, 0o700);
      const disk = JSON.parse(await fs.readFile(path.join(dir, 'highscores.json'), 'utf8'));
      a.deepEqual(disk.map(e => e.name), ['keep']);
      // the store recovers once storage is writable again
      await s.record([entry('later', 250, 3)]);
      a.deepEqual(s.list().map(e => e.name), ['later', 'keep']);
    });
  },
  async 'unreadable storage logs, lists empty, and rejects writes'() {
    await withDir(async dir => {
      await fs.mkdir(path.join(dir, 'highscores.json')); // a directory where the file should be -> EISDIR
      const log = quiet();
      const s = createLeaderboardStore({ dataDir: dir, logger: log });
      await s.ready;
      a.deepEqual(s.list(), []);
      a.equal(s.available, false);
      await a.rejects(s.record([entry('x', 200, 1)]));
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
