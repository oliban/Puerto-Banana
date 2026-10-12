const a = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createWalletsStore } = require('./wallets-store');

const quiet = () => { const errors = []; return { errors, log() {}, error: (...m) => errors.push(m.join(' ')) }; };
const T = 'a'.repeat(32), U = 'b'.repeat(32);
async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-wallets-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const tests = {
  async 'a new player has an empty wallet'() {
    await withDir(async dir => {
      const s = createWalletsStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      a.deepEqual(s.get(T), { credits: 0, stock: {}, owned: [], worn: [] });
    });
  },
  async 'changes apply at once, survive a restart, and never store the raw token'() {
    await withDir(async dir => {
      const s = createWalletsStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      s.change(T, w => { w.credits += 25; w.stock.hose = 1; w.owned.push('parrot'); w.worn.push('parrot'); });
      a.equal(s.get(T).credits, 25);
      a.equal(s.get(U).credits, 0);
      await s.flush();
      const text = await fs.readFile(path.join(dir, 'wallets.json'), 'utf8');
      a.ok(!text.includes(T), 'raw token must not be stored');
      const again = createWalletsStore({ dataDir: dir, logger: quiet() });
      await again.ready;
      a.deepEqual(again.get(T), { credits: 25, stock: { hose: 1 }, owned: ['parrot'], worn: ['parrot'] });
    });
  },
  async 'get returns a copy that cannot change the stored wallet'() {
    await withDir(async dir => {
      const s = createWalletsStore({ dataDir: dir, logger: quiet() });
      await s.ready;
      const w = s.get(T); w.credits = 999; w.owned.push('gold');
      a.deepEqual(s.get(T), { credits: 0, stock: {}, owned: [], worn: [] });
    });
  },
  async 'malformed rows are dropped; unreadable storage is unavailable'() {
    await withDir(async dir => {
      await fs.writeFile(path.join(dir, 'wallets.json'), JSON.stringify([{ id: 'x' }, { id: 'f'.repeat(64), credits: -5, stock: {}, owned: [], worn: [] }]));
      const log = quiet();
      const s = createWalletsStore({ dataDir: dir, logger: log });
      await s.ready;
      a.ok(log.errors.length >= 2);
      await fs.rm(path.join(dir, 'wallets.json'));
      await fs.mkdir(path.join(dir, 'wallets.json'));
      const broken = createWalletsStore({ dataDir: dir, logger: quiet() });
      await broken.ready;
      a.equal(broken.available, false);
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
