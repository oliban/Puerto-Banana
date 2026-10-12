// Puerto Banana — tiny zero-dependency game server (SSE + JSON POST, in-memory state).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAuction } = require('./engine');
const { createLeaderboardStore } = require('./leaderboard-store');
const { createGamesStore } = require('./games-store');
const { computeRivals } = require('./rivals');

const PORT = process.env.PORT || 8080;
const GOAL = 200, START = 10, MAX_PLAYERS = 6;
const { hullOf, flagOf } = require('./players'); // hull keys; the client maps each to a colour
const TORPEDO_ODDS = 0.2; // share of finished games where the winner's victory show torpedoes the rivals (visual only)
let random = Math.random;  // swappable in tests
const rooms = new Map();          // code -> room
const streams = new Map();        // code -> Set<{res, token}>
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));

const rid = n => crypto.randomBytes(n).toString('hex');
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c = Array.from(crypto.randomBytes(4), b => L[b % L.length]).join(''); } while (rooms.has(c));
  return c;
}

// What one player is allowed to see.
function view(room, token) {
  const me = room.players[token];
  const order = room.order.map(t => room.players[t].id);
  const inventories = {};
  room.order.forEach(t => { inventories[room.players[t].id] = room.inventories[t]; });
  return {
    code: room.code, status: room.status, round: room.round, pot: room.pot,
    me: me ? me.id : null, isHost: room.hostToken === token,
    players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
      .map(p => ({ id: p.id, nick: p.nick, hull: p.hull, flag: p.flag, locked: room.bids[p.token] !== undefined })),
    order, inventories,
    myBid: room.bids[token] ?? null,
    lastResult: room.lastResult, history: room.history, winners: room.winners, torpedo: !!room.torpedo,
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const s of streams.get(room.code) || []) {
    s.res.write(`data: ${JSON.stringify(view(room, s.token))}\n\n`);
  }
}

function resolveRound(room, stores) {
  const ids = t => room.players[t].id;
  const bids = {}; room.order.forEach(t => { bids[t] = room.bids[t] ?? 0; });
  const { inv, steps } = resolveAuction(room.inventories, bids, room.pot, room.order);
  const byId = o => Object.fromEntries(Object.entries(o).map(([t, v]) => [ids(t), v]));
  const mapStep = s => ({ ...s, id: s.id && ids(s.id), ids: s.ids && s.ids.map(ids), to: s.to && s.to.map(ids) });
  room.lastResult = { round: room.round, pot: room.pot, bids: byId(bids), before: byId(room.inventories), after: byId(inv), steps: steps.map(mapStep) };
  room.history = room.history.concat([{ round: room.round, pot: room.pot, bids: byId(bids) }]).slice(-40);
  room.inventories = inv;
  room.bids = {};
  room.round += 1;
  const top = Math.max(...room.order.map(t => inv[t]));
  room.pot = top;
  if (room.order.some(t => inv[t] >= GOAL)) {
    room.status = 'over';
    room.winners = room.order.filter(t => inv[t] === top).map(ids);
    room.torpedo = random() < TORPEDO_ODDS; // rolled once, so every player sees the same show
    recordGame(room, stores);
  }
}

// Called on the transition to 'over', from server-owned state only; once per game.
// The harbour log and the game history save independently: one failing never blocks the other.
function recordGame(room, stores) {
  if (room.scoresRecorded || !stores) return;
  room.scoresRecorded = true; // set before the async writes so nothing can record twice
  const completedAt = new Date().toISOString();
  const players = room.order.map(t => ({ name: room.players[t].nick, score: room.inventories[t],
    won: room.winners.includes(room.players[t].id), hull: room.players[t].hull }));
  stores.scores.record(players.filter(p => p.won).map(({ name, score }) => ({ name, score, completedAt })))
    .catch(e => stores.scores.logger.error(`[highscores] room ${room.code} result NOT saved:`, e.message));
  stores.games.record({ completedAt, players })
    .catch(e => stores.games.logger.error(`[games] room ${room.code} result NOT saved:`, e.message));
}

const actions = {
  create(b, token) {
    const code = newCode();
    rooms.set(code, { code, hostToken: token, status: 'lobby', players: {}, order: [], inventories: {}, bids: {}, round: 0, pot: 0, lastResult: null, history: [], winners: [], scoresRecorded: false, touched: Date.now() });
    return actions.join({ ...b, code }, token);
  },
  join(b, token) {
    const room = rooms.get(String(b.code || '').toUpperCase());
    if (!room) throw new Error('No room with that code.');
    const nick = String(b.nick || '').trim().slice(0, 20) || 'Player';
    const hull = hullOf(b.hull), flag = flagOf(b.flag);
    if (!room.players[token]) room.players[token] = { token, id: rid(4), nick, hull, flag, joinedAt: Date.now() };
    else Object.assign(room.players[token], { nick, hull, flag });
    broadcast(room); return { code: room.code };
  },
  start(b, token, room) {
    if (room.status !== 'lobby') throw new Error('Game already running.');
    const ts = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt).map(p => p.token).slice(0, MAX_PLAYERS);
    if (ts.length < 2) throw new Error('Need at least 2 players.');
    Object.assign(room, { status: 'playing', order: ts, inventories: Object.fromEntries(ts.map(t => [t, START])), bids: {}, round: 1, pot: START, lastResult: null, history: [], winners: [], torpedo: false, scoresRecorded: false });
    broadcast(room);
  },
  bid(b, token, room, stores) {
    if (room.status !== 'playing' || !room.order.includes(token)) throw new Error('You are not in this game.');
    if (room.bids[token] !== undefined) throw new Error('Bid already locked.');
    const bid = Number(b.bid);
    if (!Number.isInteger(bid) || bid < 0 || bid > 1e9) throw new Error('Bid a whole number, 0 or more.');
    room.bids[token] = bid;
    if (room.order.every(t => room.bids[t] !== undefined)) resolveRound(room, stores);
    broadcast(room);
  },
  skip(b, token, room, stores) {
    if (room.hostToken !== token) throw new Error('Only the host can do that.');
    if (room.status !== 'playing') return;
    room.order.forEach(t => { if (room.bids[t] === undefined) room.bids[t] = 0; });
    resolveRound(room, stores); broadcast(room);
  },
  lobby(b, token, room) {
    Object.assign(room, { status: 'lobby', order: [], bids: {}, round: 0, lastResult: null, history: [], winners: [], torpedo: false });
    broadcast(room);
  },
  leave(b, token, room) {
    if (room.status === 'lobby') { delete room.players[token]; if (room.hostToken === token) { const next = Object.keys(room.players)[0]; if (next) room.hostToken = next; } broadcast(room); }
  },
};

function readBody(req) {
  return new Promise((ok, fail) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { fail(e); } }); req.on('error', fail);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function createServer({ dataDir, logger = console, random: rnd } = {}) {
  random = rnd || Math.random;
  const stores = { scores: createLeaderboardStore({ dataDir, logger }), games: createGamesStore({ dataDir, logger }) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(INDEX); }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && url.pathname === '/api/highscores') {
      await stores.scores.ready;
      return stores.scores.available ? json(res, 200, stores.scores.list()) : json(res, 503, { error: 'Highscores unavailable.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/rivals') {
      await stores.games.ready;
      if (!stores.games.available) return json(res, 503, { error: 'Game history unavailable.' });
      return json(res, 200, computeRivals(stores.games.list(), url.searchParams.get('name') || ''));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const token = String(url.searchParams.get('token') || '');
      if (!room || !room.players[token]) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const s = { res, token };
      if (!streams.has(room.code)) streams.set(room.code, new Set());
      streams.get(room.code).add(s);
      res.write(`data: ${JSON.stringify(view(room, token))}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); streams.get(room.code)?.delete(s); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      try {
        const b = await readBody(req);
        const token = String(b.token || '');
        if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Bad session.');
        const fn = actions[b.action]; if (!fn) throw new Error('Unknown action.');
        let room = null;
        if (!['create', 'join'].includes(b.action)) {
          room = rooms.get(String(b.code || '').toUpperCase());
          if (!room || !room.players[token]) throw new Error('Room not found.');
        }
        return json(res, 200, fn(b, token, room, stores) || { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    res.writeHead(404); res.end();
  });
  server.stores = stores;
  return server;
}

// Forget rooms idle for 12 hours.
setInterval(() => { const cut = Date.now() - 12 * 3600e3; for (const [c, r] of rooms) if (r.touched < cut) rooms.delete(c); }, 3600e3).unref();

if (require.main === module) createServer().listen(PORT, '0.0.0.0', () => console.log('Puerto Banana on :' + PORT));
module.exports = { createServer };
