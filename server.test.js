const a = require('assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createServer } = require('./server');

const quiet = () => { const errors = []; return { errors, log() {}, error: (...m) => errors.push(m.join(' ')) }; };
const tok = () => crypto.randomBytes(16).toString('hex');

function request(port, method, pathname, body) {
  return new Promise((ok, fail) => {
    const req = http.request({ port, method, path: pathname, headers: { 'content-type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body: d ? JSON.parse(d) : null }));
    });
    req.on('error', fail); req.end(body ? JSON.stringify(body) : undefined);
  });
}
const api = (port, body) => request(port, 'POST', '/api', body);
const scores = port => request(port, 'GET', '/api/highscores');
const rivals = (port, name) => request(port, 'GET', '/api/rivals' + (name === undefined ? '' : '?name=' + encodeURIComponent(name)));

// The first SSE event is the player's current view.
function view(port, code, token) {
  return new Promise((ok, fail) => {
    const req = http.get({ port, path: `/events?room=${code}&token=${token}` }, res => {
      let d = '';
      res.on('data', c => { d += c; const m = d.match(/^data: (.*)\n\n/); if (m) { req.destroy(); ok(JSON.parse(m[1])); } });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') fail(e); });
  });
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
}

async function withServer(setup, fn, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-server-'));
  const logger = quiet();
  try {
    if (setup) await setup(dir);
    const server = createServer({ dataDir: dir, logger, ...opts });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try { await fn(server.address().port, logger, dir, server); } finally { await server.flush(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function twoPlayerGame(port, hostNick, mateNick) {
  const host = tok(), mate = tok();
  const { body: { code } } = await api(port, { action: 'create', token: host, nick: hostNick });
  a.equal((await api(port, { action: 'join', token: mate, code, nick: mateNick })).status, 200);
  a.equal((await api(port, { action: 'start', token: host, code })).status, 200);
  return { host, mate, code };
}

// A playing 3-captain game where everyone has credits and the market holds everything (random pinned, then market opened up).
async function shopGame(port, dir) {
  const host = tok(), mate = tok(), third = tok();
  const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap' });
  await api(port, { action: 'join', token: mate, code, nick: 'Bo' });
  await api(port, { action: 'join', token: third, code, nick: 'Cy' });
  await api(port, { action: 'start', token: host, code });
  return { host, mate, third, code };
}
const give = (srv, token, credits, stock = {}) => srv.stores.wallets.change(token, w => { w.credits = credits; Object.assign(w.stock, stock); });
const openMarket = (srv, code) => { const room = srv.rooms().get(code); room.market = Object.keys(require('./shop').CATALOG); };

const tests = {
  async 'every player earns credits once per game; spectators earn nothing'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok(), watcher = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap' });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate' });
      await api(port, { action: 'start', token: host, code });
      await api(port, { action: 'join', token: watcher, code, nick: 'Watch' });
      let v = await view(port, code, host);
      for (let i = 0; i < 60 && v.status === 'playing'; i++) {
        await api(port, { action: 'skip', token: host, code });
        v = await view(port, code, host);
      }
      a.equal(v.status, 'over');
      const expect = id => Math.floor(v.inventories[id] / 10) + (v.winners.includes(id) ? 10 : 0) + (v.torpedo ? 3 : 0);
      for (const id of v.order) a.equal(v.earned[id], expect(id));
      a.equal(v.wallet.credits, expect(v.me));
      const w = await view(port, code, watcher);
      a.equal(w.wallet.credits, 0);
      await api(port, { action: 'skip', token: host, code }); // poking a finished game pays nothing extra
      a.equal((await view(port, code, host)).wallet.credits, expect(v.me));
    }, { random: () => 0.5 });
  },
  async 'rooms carry a shop setting and a market; the host can switch the shop off in the lobby'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap', shop: false });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate' });
      let v = await view(port, code, mate);
      a.equal(v.shop, false);
      a.equal(v.market.length, 11);
      a.deepEqual(v.effects, []);
      a.deepEqual(v.wallet, { credits: 0, stock: {}, owned: [], worn: [] });
      a.equal((await api(port, { action: 'settings', token: mate, code, shop: true })).status, 400); // host only
      a.equal((await api(port, { action: 'settings', token: host, code, shop: true })).status, 200);
      a.equal((await view(port, code, mate)).shop, true);
      const before = (await view(port, code, host)).market.join();
      let changed = false;
      for (let i = 0; i < 6 && !changed; i++) {
        await api(port, { action: 'start', token: host, code });
        v = await view(port, code, host);
        changed = v.market.join() !== before;
        await api(port, { action: 'lobby', token: host, code });
      }
      a.ok(changed, 'a new game rolls a new market');
      a.equal((await api(port, { action: 'settings', token: host, code, shop: false })).status, 200);
      a.equal((await view(port, code, host)).shop, false);
    });
  },
  async 'the shop catalogue is served'() {
    await withServer(null, async port => {
      const r = await request(port, 'GET', '/api/shop');
      a.equal(r.status, 200);
      a.equal(r.body.catalog.kraken.price, 15);
      a.deepEqual(r.body.emotes, ['honk', 'ha', 'oops', 'ouch']);
    });
  },
  async 'a room saved before the shop existed gets the shop on and a market'() {
    await withServer(async dir => {
      await fs.writeFile(path.join(dir, 'rooms.json'), JSON.stringify([{ code: 'OLDR', hostToken: 'c'.repeat(32), status: 'lobby',
        players: { ['c'.repeat(32)]: { token: 'c'.repeat(32), id: 'aaaa', nick: 'Old', joinedAt: 1 } }, order: [], inventories: {}, bids: {},
        round: 0, pot: 0, lastResult: null, history: [], winners: [], touched: Date.now() }]));
    }, async port => {
      const v = await view(port, 'OLDR', 'c'.repeat(32));
      a.equal(v.shop, true);
      a.equal(v.market.length, 11);
      a.deepEqual(v.effects, []);
    });
  },
  async 'the bid scratchpad recognizer is served as JavaScript'() {
    await withServer(null, async port => {
      const r = await new Promise((ok, fail) => http.get({ port, path: '/digits.js' }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body: d })); }).on('error', fail));
      a.equal(r.status, 200);
      a.match(r.type, /javascript/);
      a.match(r.body, /Digits\.load\(DIGIT_MODEL\)/);
    });
  },
  async 'the host can rematch straight from the end screen; leavers are dropped, others cannot rematch'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok(), third = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap' });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate' });
      await api(port, { action: 'join', token: third, code, nick: 'Third' });
      await api(port, { action: 'start', token: host, code });
      let v = await view(port, code, host);
      for (let i = 0; i < 60 && v.status === 'playing'; i++) {
        await api(port, { action: 'skip', token: host, code });
        v = await view(port, code, host);
      }
      a.equal(v.status, 'over');
      a.equal((await api(port, { action: 'rematch', token: mate, code })).status, 400); // only the host
      await api(port, { action: 'leave', token: third, code }); // bows out on the end screen
      a.equal((await api(port, { action: 'rematch', token: host, code })).status, 200);
      v = await view(port, code, mate);
      a.equal(v.status, 'playing');
      a.equal(v.round, 1);
      a.deepEqual(v.players.map(p => p.nick), ['Cap', 'Mate']);
      a.deepEqual(Object.values(v.inventories), [10, 10]);
      a.deepEqual(v.taunts, {}); a.equal(v.torpedo, false); a.equal(v.lastResult, null);
    });
  },
  async 'rooms survive a server restart: same players, same round, locked bids'() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-restart-'));
    const logger = quiet();
    const start = async () => { const srv = createServer({ dataDir: dir, logger }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); return srv; };
    const stop = async srv => { await srv.flush(); srv.closeAllConnections?.(); await new Promise(r => srv.close(r)); };
    try {
      let srv = await start(), port = srv.address().port;
      const g = await twoPlayerGame(port, 'Cap', 'Mate');
      await api(port, { action: 'bid', token: g.host, code: g.code, bid: 3 });
      const before = await view(port, g.code, g.mate);
      await stop(srv);

      srv = await start(); port = srv.address().port; // a fresh server reading the same data dir
      const after = await view(port, g.code, g.mate);
      a.equal(after.status, 'playing');
      a.equal(after.round, before.round);
      a.deepEqual(after.inventories, before.inventories);
      a.equal(after.players.find(p => p.nick === 'Cap').locked, true);
      a.equal((await api(port, { action: 'bid', token: g.mate, code: g.code, bid: 0 })).status, 200); // the game goes on
      a.equal((await view(port, g.code, g.host)).round, before.round + 1);
      await stop(srv);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  },
  async 'only the host can start the game, and everyone can see who the host is'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap' });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate' });
      const r = await api(port, { action: 'start', token: mate, code });
      a.equal(r.status, 400);
      a.match(r.body.error, /host/i);
      const v = await view(port, code, mate);
      a.equal(v.status, 'lobby');
      a.equal(v.hostId, v.players.find(p => p.nick === 'Cap').id);
      a.equal((await api(port, { action: 'start', token: host, code })).status, 200);
      a.equal((await view(port, code, mate)).status, 'playing');
    });
  },
  async 'the home page carries a social preview with absolute links; invite links name the room'() {
    await withServer(null, async port => {
      const page = (p, headers = {}) => new Promise((ok, fail) => http.get({ port, path: p, headers }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => ok(d)); }).on('error', fail));
      const meta = (html, prop) => (html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`)) || [])[1];
      const home = await page('/', { host: 'banana.example', 'x-forwarded-proto': 'https' });
      a.equal(meta(home, 'og:image'), 'https://banana.example/assets/og.png');
      a.equal(meta(home, 'og:url'), 'https://banana.example/');
      a.equal(meta(home, 'twitter:card'), 'summary_large_image');
      a.match(meta(home, 'og:title'), /Puerto Banana/);
      a.match(home, /<link rel="icon" href="\/assets\/favicon.svg"/);
      const invite = await page('/?join=qgww', { host: 'banana.example', 'x-forwarded-proto': 'https' });
      a.match(meta(invite, 'og:title'), /QGWW/);
      a.equal(meta(invite, 'og:url'), 'https://banana.example/?join=QGWW');
      // Some share targets glue the invite text onto the link: the code is still the first four letters
      const glued = await page('/?join=RZLG%20Join%20my%20Puerto%20Banana%20room!%20Code:%20RZLG', { host: 'banana.example', 'x-forwarded-proto': 'https' });
      a.match(meta(glued, 'og:title'), /RZLG$/);
      a.equal(meta(glued, 'og:url'), 'https://banana.example/?join=RZLG');
      const evil = await page('/?join=%22%3E%3Cscript%3E', { host: 'x"><script>alert(1)</script>' });
      a.ok(!evil.includes('<script>alert'), 'host header and code never reach the page raw');
      a.equal(meta(evil, 'og:image'), 'https://puerto-banana.fly.dev/assets/og.png');
      a.doesNotMatch(meta(evil, 'og:title'), /script/);
    });
  },
  async 'assets are served with a type and a locked-down policy; nothing outside assets/ is'() {
    await withServer(null, async port => {
      const raw = (p) => new Promise((ok, fail) => http.get({ port, path: p }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: d })); }).on('error', fail));
      const svg = await raw('/assets/test-fixture.svg');
      a.equal(svg.status, 200);
      a.equal(svg.headers['content-type'], 'image/svg+xml');
      a.match(svg.headers['content-security-policy'], /default-src 'none'/);
      a.match(svg.body, /<svg/);
      for (const bad of ['/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/..%2fserver.js', '/assets/test-fixture.js', '/assets/missing.svg', '/server.js'])
        a.equal((await raw(bad)).status, 404, bad);
    });
  },
  async 'players carry their cabin colour; unknown colours fall back to white'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap', cabin: 'mint' });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate', cabin: 'url(x)' });
      const v = await view(port, code, host);
      a.deepEqual(v.players.map(p => [p.nick, p.cabin]), [['Cap', 'mint'], ['Mate', 'white']]);
    });
  },
  async 'players carry their flag; anything unknown falls back to the pennant'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok(), third = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap', flag: 'se' });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate', flag: 'pirate' });
      await api(port, { action: 'join', token: third, code, nick: 'Odd', flag: '../x" onload="alert(1)' });
      let v = await view(port, code, host);
      a.deepEqual(v.players.map(p => [p.nick, p.flag]), [['Cap', 'se'], ['Mate', 'pirate'], ['Odd', '']]);
      await api(port, { action: 'join', token: third, code, nick: 'Odd', flag: 'gb-sct' });
      v = await view(port, code, host);
      a.equal(v.players.find(p => p.nick === 'Odd').flag, 'gb-sct');
      await api(port, { action: 'join', token: third, code, nick: 'Odd', flag: 'ls-skane' });
      a.equal((await view(port, code, host)).players.find(p => p.nick === 'Odd').flag, 'ls-skane');
      await api(port, { action: 'join', token: third, code, nick: 'Odd', flag: 'ls-atlantis' });
      a.equal((await view(port, code, host)).players.find(p => p.nick === 'Odd').flag, '');
    });
  },
  async 'players carry their hull colour; unknown colours fall back to navy'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap', hull: 'coral' });
      await api(port, { action: 'join', token: mate, code, nick: 'Mate', hull: 'red;background:url(x)' });
      let v = await view(port, code, host);
      a.deepEqual(v.players.map(p => [p.nick, p.hull]), [['Cap', 'coral'], ['Mate', 'navy']]);
      await api(port, { action: 'join', token: mate, code, nick: 'Mate', hull: 'mango' });
      v = await view(port, code, host);
      a.equal(v.players.find(p => p.nick === 'Mate').hull, 'mango');
    });
  },
  async 'empty leaderboard is an empty JSON array'() {
    await withServer(null, async port => {
      const r = await scores(port);
      a.equal(r.status, 200);
      a.match(r.type, /application\/json/);
      a.deepEqual(r.body, []);
    });
  },
  async 'tied winners each get one entry with authoritative scores, recorded once'() {
    await withServer(null, async port => {
      const g = await twoPlayerGame(port, '<b>Cap</b>', 'Mate');
      let v;
      for (let i = 0; i < 50; i++) {
        await api(port, { action: 'skip', token: g.host, code: g.code, score: 99999, name: 'forged' });
        v = await view(port, g.code, g.host);
        if (v.status === 'over') break;
      }
      a.equal(v.status, 'over');
      a.equal(v.winners.length, 2);
      const expected = v.winners.map(id => v.inventories[id]);
      const list = (await until(async () => { const r = await scores(port); return r.body.length === 2 && r.body; }));
      a.deepEqual(list.map(e => e.score).sort(), expected.sort());
      a.deepEqual(list.map(e => e.name).sort(), ['<b>Cap</b>', 'Mate']);
      a.equal(list[0].completedAt, list[1].completedAt);
      a.deepEqual(Object.keys(list[0]).sort(), ['completedAt', 'name', 'score']);

      // Poking a finished room or reconnecting must not add entries.
      await api(port, { action: 'skip', token: g.host, code: g.code });
      a.equal((await api(port, { action: 'bid', token: g.mate, code: g.code, bid: 5 })).status, 400);
      await view(port, g.code, g.mate); await view(port, g.code, g.host);
      await new Promise(r => setTimeout(r, 100));
      a.equal((await scores(port)).body.length, 2);
    });
  },
  async 'a single winner is recorded from final inventory and forged fields are ignored'() {
    await withServer(null, async port => {
      const g = await twoPlayerGame(port, 'Alice', 'Bob');
      let v = await view(port, g.code, g.host);
      const meId = v.me;
      for (let i = 0; i < 50 && v.status === 'playing'; i++) {
        // Host overbids its whole stash each round; Bob bids 0 and keeps winning the pot.
        await api(port, { action: 'bid', token: g.host, code: g.code, bid: v.inventories[meId] + v.pot + 1, name: 'x', score: 1e6, completedAt: '2000-01-01T00:00:00Z' });
        await api(port, { action: 'bid', token: g.mate, code: g.code, bid: 0, score: 1e6 });
        v = await view(port, g.code, g.host);
      }
      a.equal(v.status, 'over');
      a.equal(v.winners.length, 1);
      const winScore = v.inventories[v.winners[0]];
      const list = await until(async () => { const r = await scores(port); return r.body.length === 1 && r.body; });
      a.deepEqual(list.map(({ name, score }) => ({ name, score })), [{ name: 'Bob', score: winScore }]);
      a.ok(Date.now() - Date.parse(list[0].completedAt) < 60e3);

      // Back to lobby and play again: the new game records separately.
      await api(port, { action: 'lobby', token: g.host, code: g.code });
      await api(port, { action: 'start', token: g.host, code: g.code });
      for (let i = 0; i < 50; i++) {
        await api(port, { action: 'skip', token: g.host, code: g.code });
        if ((await view(port, g.code, g.host)).status === 'over') break;
      }
      await until(async () => (await scores(port)).body.length === 3);
    });
  },
  async 'a finished game rolls the torpedo show once (1 in 5); a new game starts without it'() {
    for (const [roll, expected] of [[0.1, true], [0.5, false]]) {
      await withServer(null, async port => {
        const g = await twoPlayerGame(port, 'A', 'B');
        let v = await view(port, g.code, g.host);
        a.equal(v.torpedo, false);
        for (let i = 0; i < 50 && v.status === 'playing'; i++) {
          await api(port, { action: 'skip', token: g.host, code: g.code });
          v = await view(port, g.code, g.host);
        }
        a.equal(v.status, 'over');
        a.equal(v.torpedo, expected);
        a.equal((await view(port, g.code, g.mate)).torpedo, expected); // everyone sees the same show
        await api(port, { action: 'lobby', token: g.host, code: g.code });
        await api(port, { action: 'start', token: g.host, code: g.code });
        a.equal((await view(port, g.code, g.host)).torpedo, false);
      }, { random: () => roll });
    }
  },
  async 'a finished game is saved once to the history with wins and hulls; spectators are not'() {
    await withServer(null, async port => {
      const host = tok(), mate = tok(), watcher = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Anna', hull: 'coral' });
      await api(port, { action: 'join', token: mate, code, nick: 'Bo', hull: 'mango' });
      await api(port, { action: 'start', token: host, code });
      await api(port, { action: 'join', token: watcher, code, nick: 'Cy' }); // joined after start: spectator
      let v;
      for (let i = 0; i < 50; i++) {
        await api(port, { action: 'skip', token: host, code });
        v = await view(port, code, host);
        if (v.status === 'over') break;
      }
      a.equal(v.status, 'over');
      const r = await until(async () => { const x = await rivals(port, 'anna'); return x.body.players.length === 2 && x.body; });
      a.equal(r.mode, 'rivals');
      a.deepEqual(r.players.map(p => p.key).sort(), ['anna', 'bo']);
      a.equal(r.players.find(p => p.key === 'anna').hull, 'coral');
      a.equal(r.players.reduce((n, p) => n + p.won, 0) >= 1, true);
      a.equal(r.games.length, 1);

      // Poking a finished room or reconnecting must not add a second game.
      await api(port, { action: 'skip', token: host, code });
      await view(port, code, mate);
      await new Promise(res => setTimeout(res, 100));
      a.equal((await rivals(port, 'anna')).body.games.length, 1);
      a.equal((await rivals(port, 'Cy')).body.mode, 'active'); // the spectator never played
    });
  },
  async 'rivals without a name falls back to the most active captains'() {
    await withServer(null, async port => {
      const r = await rivals(port);
      a.equal(r.status, 200);
      a.match(r.type, /application\/json/);
      a.deepEqual(r.body, { mode: 'active', me: null, games: [], players: [] });
    });
  },
  async 'unreadable game history answers 503 while games and the harbour log still work'() {
    await withServer(dir => fs.mkdir(path.join(dir, 'games.json')), async (port, logger) => {
      const r = await rivals(port, 'A');
      a.equal(r.status, 503);
      a.deepEqual(r.body, { error: 'Game history unavailable.' });
      const g = await twoPlayerGame(port, 'A', 'B');
      let v;
      for (let i = 0; i < 50; i++) {
        await api(port, { action: 'skip', token: g.host, code: g.code });
        v = await view(port, g.code, g.host);
        if (v.status === 'over') break;
      }
      a.equal(v.status, 'over');
      await until(async () => (await scores(port)).body.length >= 1);
      await until(() => logger.errors.some(e => /\[games\]/.test(e)));
    });
  },
  async 'losers ending with 10 bananas or fewer get one taunt each, picked once; others get none'() {
    await withServer(null, async port => {
      const rich = tok(), mid = tok(), broke = tok();
      const { body: { code } } = await api(port, { action: 'create', token: rich, nick: 'Rich' });
      await api(port, { action: 'join', token: mid, code, nick: 'Mid' });
      await api(port, { action: 'join', token: broke, code, nick: 'Broke' });
      await api(port, { action: 'start', token: rich, code });
      let v = await view(port, code, rich);
      a.deepEqual(v.taunts, {});
      const id = nick => v.players.find(p => p.nick === nick).id;
      for (let i = 0; i < 50 && v.status === 'playing'; i++) {
        // Broke overbids and can't pay (3+ players: loses everything); Rich then wins and pays Mid the gap
        await api(port, { action: 'bid', token: broke, code, bid: 100000 });
        await api(port, { action: 'bid', token: rich, code, bid: 1 });
        await api(port, { action: 'bid', token: mid, code, bid: 0 });
        v = await view(port, code, rich);
      }
      a.equal(v.status, 'over');
      a.ok(v.inventories[id('Broke')] <= 10 && v.inventories[id('Mid')] > 10);
      a.deepEqual(Object.keys(v.taunts), [id('Broke')]); // only the low loser; never the winner or Mid
      a.ok(Number.isInteger(v.taunts[id('Broke')]) && v.taunts[id('Broke')] >= 0);
      a.deepEqual((await view(port, code, mid)).taunts, v.taunts); // same pick on every screen
      await api(port, { action: 'lobby', token: rich, code });
      a.deepEqual((await view(port, code, rich)).taunts, {});
    }, { random: () => 0.5 });
  },
  async 'unavailable storage keeps health, rooms and games working'() {
    await withServer(dir => fs.mkdir(path.join(dir, 'highscores.json')), async (port, logger) => {
      const h = await request(port, 'GET', '/healthz');
      a.equal(h.status, 200); a.equal(h.body.ok, true);
      const r = await scores(port);
      a.equal(r.status, 503);
      a.deepEqual(r.body, { error: 'Highscores unavailable.' });
      const g = await twoPlayerGame(port, 'A', 'B');
      let v;
      for (let i = 0; i < 50; i++) {
        await api(port, { action: 'skip', token: g.host, code: g.code });
        v = await view(port, g.code, g.host);
        if (v.status === 'over') break;
      }
      a.equal(v.status, 'over');
      await until(() => logger.errors.some(e => /unavailable/i.test(e)));
      a.equal((await scores(port)).status, 503);
    });
  },
  async 'sabotage costs credits, needs stock in the market, hits rivals only and respects the limits'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const g = await shopGame(port);
      const v0 = await view(port, g.code, g.host);
      const [cap, bo, cy] = v0.order;
      openMarket(srv, g.code);
      const buy = (token, item, target) => api(port, { action: 'buy', token, code: g.code, item, target });
      let r = await buy(g.host, 'kraken', bo);
      a.equal(r.status, 400); a.equal(r.body.error, 'Not enough 🪙: Kraken costs 15.');
      give(srv, g.host, 100); give(srv, g.mate, 100); give(srv, g.third, 100);
      a.equal((await buy(g.host, 'kraken', cap)).body.error, "Pick a rival's ship.");
      r = await buy(g.host, 'kraken', bo);
      a.equal(r.status, 200); a.equal(r.body.wallet.credits, 85);
      a.equal((await buy(g.host, 'shark', cy)).body.error, "You've already sabotaged this round.");
      a.equal((await buy(g.third, 'bomb', bo)).status, 200);
      a.equal((await buy(g.mate, 'cloud', cap)).status, 200);
      const sab = (await view(port, g.code, g.mate)).effects.filter(e => e.target === bo);
      a.deepEqual(sab.map(e => e.kind).sort(), ['bomb', 'kraken']);
      srv.rooms().get(g.code).market = ['shark'];
      a.equal((await buy(g.mate, 'gulls', cap)).body.error, 'Not for sale this game: check back next game!');
      a.equal((await buy(g.host, 'nonsense', bo)).body.error, 'Unknown item.');
    });
  },
  async 'the third sabotage on one ship is refused and keeps its credits'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const host = tok(), b = tok(), c = tok(), d = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap' });
      for (const [t, n] of [[b, 'Bo'], [c, 'Cy'], [d, 'Di']]) await api(port, { action: 'join', token: t, code, nick: n });
      await api(port, { action: 'start', token: host, code });
      openMarket(srv, code);
      const v = await view(port, code, host);
      const bo = v.players.find(p => p.nick === 'Bo').id;
      for (const t of [host, c, d]) give(srv, t, 50);
      await api(port, { action: 'buy', token: host, code, item: 'shark', target: bo });
      await api(port, { action: 'buy', token: c, code, item: 'shark', target: bo });
      const r = await api(port, { action: 'buy', token: d, code, item: 'shark', target: bo });
      a.equal(r.body.error, "Bo's ship can't take any more right now.");
      a.equal(srv.stores.wallets.get(d).credits, 50);
    });
  },
  async 'a matching defence blocks and is used up; bubble blocks anything; the attacker still pays'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const g = await shopGame(port);
      openMarket(srv, g.code);
      const [, bo, cy] = (await view(port, g.code, g.host)).order;
      give(srv, g.host, 100); give(srv, g.third, 100);
      give(srv, g.mate, 0, { hose: 1, bubble: 1 });
      await api(port, { action: 'buy', token: g.host, code: g.code, item: 'bomb', target: bo });
      let fx = (await view(port, g.code, g.mate)).effects.find(e => e.kind === 'bomb');
      a.equal(fx.blocked, 'hose');
      a.deepEqual(srv.stores.wallets.get(g.mate).stock, { bubble: 1 });
      a.equal(srv.stores.wallets.get(g.host).credits, 88);
      await api(port, { action: 'buy', token: g.third, code: g.code, item: 'kraken', target: bo });
      fx = (await view(port, g.code, g.mate)).effects.find(e => e.kind === 'kraken');
      a.equal(fx.blocked, 'bubble');
      a.deepEqual(srv.stores.wallets.get(g.mate).stock, {});
    });
  },
  async 'sabotage and gifts end with their round; the diamond lasts the game; a rematch clears everything'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const g = await shopGame(port);
      openMarket(srv, g.code);
      const [, bo, cy] = (await view(port, g.code, g.host)).order;
      give(srv, g.host, 200); give(srv, g.mate, 200);
      await api(port, { action: 'buy', token: g.host, code: g.code, item: 'kraken', target: bo });
      await api(port, { action: 'buy', token: g.mate, code: g.code, item: 'diamond', target: cy });
      await api(port, { action: 'buy', token: g.host, code: g.code, item: 'cake', target: cy });
      await api(port, { action: 'skip', token: g.host, code: g.code }); // round 1 resolves
      let kinds = (await view(port, g.code, g.host)).effects.map(e => e.kind);
      a.deepEqual(kinds, ['diamond']);
      let v = await view(port, g.code, g.host);
      for (let i = 0; i < 60 && v.status === 'playing'; i++) { await api(port, { action: 'skip', token: g.host, code: g.code }); v = await view(port, g.code, g.host); }
      a.deepEqual(v.effects.map(e => e.kind), ['diamond']);
      await api(port, { action: 'rematch', token: g.host, code: g.code });
      a.deepEqual((await view(port, g.code, g.host)).effects, []);
    });
  },
  async 'gifts: any status, one per round, never blocked, three shown per ship'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const host = tok(), b = tok(), c = tok(), d = tok(), e = tok();
      const { body: { code } } = await api(port, { action: 'create', token: host, nick: 'Cap' });
      for (const [t, n] of [[b, 'Bo'], [c, 'Cy'], [d, 'Di'], [e, 'Ed']]) await api(port, { action: 'join', token: t, code, nick: n });
      openMarket(srv, code);
      const cap = (await view(port, code, host)).players.find(p => p.nick === 'Cap').id;
      for (const t of [b, c, d, e]) give(srv, t, 50, { bubble: 1 });
      give(srv, host, 0, { bubble: 1 });
      for (const t of [b, c, d, e]) a.equal((await api(port, { action: 'buy', token: t, code, item: 'lei', target: cap })).status, 200);
      a.equal((await api(port, { action: 'buy', token: b, code, item: 'bottle', target: cap })).body.error, "You've already sent a gift this round.");
      const gifts = (await view(port, code, host)).effects.filter(x => x.target === cap);
      a.equal(gifts.length, 3);
      a.ok(gifts.every(x => !x.blocked));
      a.deepEqual(srv.stores.wallets.get(host).stock, { bubble: 1 });
    });
  },
  async 'bling is bought once, worn and unworn, kept through reconnects, and hidden when the shop is off'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const g = await shopGame(port);
      openMarket(srv, g.code);
      give(srv, g.host, 300);
      a.equal((await api(port, { action: 'buy', token: g.host, code: g.code, item: 'parrot' })).status, 200);
      a.equal((await api(port, { action: 'buy', token: g.host, code: g.code, item: 'parrot' })).body.error, 'You already own that.');
      const me = (await view(port, g.code, g.mate)).players.find(p => p.nick === 'Cap');
      a.deepEqual(me.bling, ['parrot']);
      await api(port, { action: 'wear', token: g.host, code: g.code, item: 'parrot', on: false });
      a.deepEqual((await view(port, g.code, g.mate)).players.find(p => p.nick === 'Cap').bling, []);
      await api(port, { action: 'wear', token: g.host, code: g.code, item: 'parrot', on: true });
      await api(port, { action: 'join', token: g.host, code: g.code, nick: 'Cap' }); // reconnect
      a.deepEqual((await view(port, g.code, g.mate)).players.find(p => p.nick === 'Cap').bling, ['parrot']);
      a.equal(srv.stores.wallets.get(g.host).credits, 260);
      srv.rooms().get(g.code).shop = false;
      const off = await view(port, g.code, g.mate);
      a.deepEqual(off.players.find(p => p.nick === 'Cap').bling, []);
      a.equal((await api(port, { action: 'buy', token: g.host, code: g.code, item: 'gold' })).body.error, 'The shop is off in this room.');
      a.equal((await api(port, { action: 'wear', token: g.host, code: g.code, item: 'parrot', on: false })).body.error, 'The shop is off in this room.');
    });
  },
  async 'emotes are free with a 10 s cooldown and fade from the view'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const g = await shopGame(port);
      a.equal((await api(port, { action: 'emote', token: g.mate, code: g.code, kind: 'honk' })).status, 200);
      a.equal((await api(port, { action: 'emote', token: g.mate, code: g.code, kind: 'ha' })).body.error, 'Wait a moment before the next one.');
      a.equal((await api(port, { action: 'emote', token: g.host, code: g.code, kind: 'nope' })).body.error, 'Unknown item.');
      let fx = (await view(port, g.code, g.host)).effects.filter(e => e.kind === 'emote');
      a.equal(fx.length, 1); a.equal(fx[0].emote, 'honk');
      srv.rooms().get(g.code).effects.forEach(e => { e.at -= 5000; });
      fx = (await view(port, g.code, g.host)).effects.filter(e => e.kind === 'emote');
      a.equal(fx.length, 0);
    });
  },
  async 'a diamond survives any number of emotes; faded emotes are pruned from the room'() {
    await withServer(null, async (port, _l, _d, srv) => {
      const g = await shopGame(port);
      openMarket(srv, g.code);
      const cy = (await view(port, g.code, g.host)).order[2];
      give(srv, g.host, 100);
      a.equal((await api(port, { action: 'buy', token: g.host, code: g.code, item: 'diamond', target: cy })).status, 200);
      const room = srv.rooms().get(g.code);
      const me = (await view(port, g.code, g.host)).me;
      for (let i = 0; i < 100; i++) room.effects.push({ kind: 'emote', emote: 'honk', from: me, at: Date.now() - 5000 });
      a.equal((await api(port, { action: 'emote', token: g.mate, code: g.code, kind: 'ha' })).status, 200); // broadcasts
      a.ok(room.effects.every(e => e.kind !== 'emote' || Date.now() - e.at <= 4000));
      a.equal(room.effects.filter(e => e.kind === 'emote').length, 1);
      a.ok((await view(port, g.code, g.host)).effects.some(e => e.kind === 'diamond'));
    });
  },
  async 'shop actions fail politely when wallet storage is broken; games still finish'() {
    await withServer(dir => fs.mkdir(path.join(dir, 'wallets.json')), async port => {
      const g = await twoPlayerGame(port, 'A', 'B');
      a.equal((await api(port, { action: 'buy', token: g.host, code: g.code, item: 'shark', target: 'x' })).body.error, 'The shop is closed right now.');
      let v;
      for (let i = 0; i < 60; i++) { await api(port, { action: 'skip', token: g.host, code: g.code }); v = await view(port, g.code, g.host); if (v.status === 'over') break; }
      a.equal(v.status, 'over');
      a.equal(v.wallet, null);
    });
  },
  async 'the home page is still served'() {
    await withServer(null, async port => {
      const r = await new Promise(ok => http.get({ port, path: '/' }, res => { res.resume(); ok(res); }));
      a.equal(r.statusCode, 200);
    });
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
  }
  console.log(failed ? `${failed} failed` : 'all pass');
  process.exit(failed ? 1 : 0);
})();
