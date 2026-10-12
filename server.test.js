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
    try { await fn(server.address().port, logger, dir); } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function twoPlayerGame(port, hostNick, mateNick) {
  const host = tok(), mate = tok();
  const { body: { code } } = await api(port, { action: 'create', token: host, nick: hostNick });
  a.equal((await api(port, { action: 'join', token: mate, code, nick: mateNick })).status, 200);
  a.equal((await api(port, { action: 'start', token: host, code })).status, 200);
  return { host, mate, code };
}

const tests = {
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
