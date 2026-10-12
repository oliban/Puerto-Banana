// Puerto Banana — tiny zero-dependency game server (SSE + JSON POST, in-memory state).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAuction } = require('./engine');
const { createLeaderboardStore } = require('./leaderboard-store');
const { createGamesStore } = require('./games-store');
const { computeRivals } = require('./rivals');
const { createJsonFileStore } = require('./json-file-store');
const { CATALOG, EMOTES, rollMarket, earnings, blockerFor } = require('./shop');
const { createWalletsStore } = require('./wallets-store');

const PORT = process.env.PORT || 8080;
const GOAL = 200, START = 10, MAX_PLAYERS = 6;
const { hullOf, cabinOf, flagOf } = require('./players'); // hull keys; the client maps each to a colour
const TAUNT_MAX = 10; // a loser ending with this many bananas or fewer gets taunted (by their flag, client-side)
const TORPEDO_ODDS = 0.2; // share of finished games where the winner's victory show torpedoes the rivals (visual only)
let random = Math.random;  // swappable in tests
const rooms = new Map();          // code -> room
const streams = new Map();        // code -> Set<{res, token}>
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const DIGITS = fs.readFileSync(path.join(__dirname, 'digits.js')); // bid scratchpad: handwritten-digit recognizer
const HOME = 'https://puerto-banana.fly.dev';
// The home page with its social-preview tags filled in. Links must be absolute, so they use the address the
// page was requested on (only if it looks like a plain host); an invite link (?join=ABCD) names the room.
function indexFor(req, url) {
  const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(req.headers.host || '') ? req.headers.host : '';
  const proto = req.headers['x-forwarded-proto'] === 'https' || !/^(localhost|127\.|\[::1\])/.test(host) ? 'https' : 'http';
  const origin = host ? `${proto}://${host}` : HOME;
  // Some apps glue the share text onto the link (?join=RZLG Join my…), so the code is the first four letters.
  const code = ((url.searchParams.get('join') || '').match(/^[a-z]{4}(?![a-z])/i) || [''])[0].toUpperCase();
  const fill = {
    ORIGIN: origin,
    URL: origin + (code ? `/?join=${code}` : '/'),
    TITLE: code ? `Join my Puerto Banana room: ${code}` : 'Puerto Banana: bid blind for banana cargo',
    DESC: code ? `You're invited aboard! Pick a name, join room ${code} and bid blind for bananas. First to 200 wins.`
      : 'A blind-bid banana auction for 2-6 friends, each on their own phone. Win the cargo, pay the runner-up the gap. First to 200 bananas wins.',
  };
  return INDEX.replace(/%%(ORIGIN|URL|TITLE|DESC)%%/g, (_, k) => fill[k]);
}
// Static files: only assets/<lowercase path>.(svg|png|ico|json), never anything outside that folder.
const ASSETS = path.join(__dirname, 'assets');
const TYPES = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json; charset=utf-8' };
function serveAsset(res, pathname) {
  const m = /^\/assets\/([a-z0-9_-]+(?:\/[a-z0-9_-]+)*)\.(svg|png|ico|json)$/.exec(pathname);
  if (!m) return false;
  const file = path.join(ASSETS, `${m[1]}.${m[2]}`);
  if (!file.startsWith(ASSETS + path.sep)) return false;
  let body;
  try { body = fs.readFileSync(file); } catch (e) { return false; }
  res.writeHead(200, { 'content-type': TYPES[m[2]], 'cache-control': 'public, max-age=86400',
    // An SVG opened directly is a document: allow its own styles, never scripts or outside loads.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'x-content-type-options': 'nosniff' });
  res.end(body);
  return true;
}

const rid = n => crypto.randomBytes(n).toString('hex');
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c = Array.from(crypto.randomBytes(4), b => L[b % L.length]).join(''); } while (rooms.has(c));
  return c;
}

// Rooms saved before the shop existed get it switched on with a freshly rolled market.
function ensureShop(room) {
  if (room.shop === undefined) room.shop = true;
  if (!Array.isArray(room.market)) room.market = rollMarket(random);
  if (!Array.isArray(room.effects)) room.effects = [];
}
const kindOf = k => CATALOG[k] && CATALOG[k].kind;
// What every screen should be drawing right now: short-lived entries fade, players who left are dropped,
// and a ship shows at most its three newest gifts.
function liveEffects(room) {
  ensureShop(room);
  if (!room.shop) return [];
  const now = Date.now(), present = new Set(Object.values(room.players).map(p => p.id));
  const live = room.effects.filter(e => present.has(e.from) && (!e.target || present.has(e.target))
    && !(e.kind === 'emote' && now - e.at > 4000) && !(e.blocked && now - e.at > 4000)
    && !(kindOf(e.kind) === 'gift' && e.round === 0 && now - e.at > 30000));
  const gifts = {};
  return live.reverse().filter(e => kindOf(e.kind) !== 'gift' || (gifts[e.target] = (gifts[e.target] || 0) + 1) <= 3).reverse();
}
let walletsRef = null; // the server's wallet store, for view()

// What one player is allowed to see.
function view(room, token) {
  ensureShop(room);
  const me = room.players[token];
  const order = room.order.map(t => room.players[t].id);
  const inventories = {};
  room.order.forEach(t => { inventories[room.players[t].id] = room.inventories[t]; });
  return {
    code: room.code, status: room.status, round: room.round, pot: room.pot,
    me: me ? me.id : null, isHost: room.hostToken === token, hostId: room.players[room.hostToken]?.id ?? null,
    players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
      .map(p => ({ id: p.id, nick: p.nick, hull: p.hull, cabin: p.cabin, flag: p.flag, bling: room.shop ? (p.bling || []) : [], locked: room.bids[p.token] !== undefined })),
    order, inventories,
    myBid: room.bids[token] ?? null,
    lastResult: room.lastResult, history: room.history, winners: room.winners, torpedo: !!room.torpedo, taunts: room.taunts || {},
    shop: room.shop, market: room.market, effects: liveEffects(room), earned: room.earned || {},
    wallet: walletsRef && walletsRef.available && me ? walletsRef.get(token) : null,
  };
}

// Rooms are saved to rooms.json (on the volume) shortly after every change, so games survive restarts and deploys.
let scheduleSave = () => {};
const ROOM_TTL = 12 * 3600e3;
const cleanRoom = r => r && typeof r === 'object' && /^[A-Z]{4}$/.test(r.code) && typeof r.hostToken === 'string'
  && r.players && typeof r.players === 'object' && Number.isFinite(r.touched) ? r : null;

function broadcast(room) {
  room.touched = Date.now();
  scheduleSave();
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
    // One taunt pick per low-scoring loser; the client maps it onto that flag's taunts (pick % count)
    room.taunts = Object.fromEntries(room.order.filter(t => inv[t] <= TAUNT_MAX && !room.winners.includes(ids(t)))
      .map(t => [ids(t), Math.floor(random() * 1000)]));
    recordGame(room, stores);
  }
}

// Called on the transition to 'over', from server-owned state only; once per game.
// The harbour log and the game history save independently: one failing never blocks the other.
function recordGame(room, stores) {
  if (room.scoresRecorded || !stores) return;
  room.scoresRecorded = true; // set before the async writes so nothing can record twice
  // Shop credits: every player in the game, once (same guard as scores). Missing storage only costs the credits.
  room.earned = {};
  for (const t of room.order) {
    const p = room.players[t];
    const amount = earnings({ score: room.inventories[t], won: room.winners.includes(p.id), torpedo: !!room.torpedo });
    room.earned[p.id] = amount;
    if (stores.wallets && stores.wallets.available) stores.wallets.change(t, w => { w.credits += amount; });
  }
  if (stores.wallets && !stores.wallets.available) stores.wallets.logger.error(`[wallets] room ${room.code} credits NOT saved: storage unavailable`);
  const completedAt = new Date().toISOString();
  const players = room.order.map(t => ({ name: room.players[t].nick, score: room.inventories[t],
    won: room.winners.includes(room.players[t].id), hull: room.players[t].hull }));
  stores.scores.record(players.filter(p => p.won).map(({ name, score }) => ({ name, score, completedAt })))
    .catch(e => stores.scores.logger.error(`[highscores] room ${room.code} result NOT saved:`, e.message));
  stores.games.record({ completedAt, players })
    .catch(e => stores.games.logger.error(`[games] room ${room.code} result NOT saved:`, e.message));
}

// Deal a fresh game to the room's players (the first MAX_PLAYERS by join order).
function newGame(room) {
  const ts = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt).map(p => p.token).slice(0, MAX_PLAYERS);
  if (ts.length < 2) throw new Error('Need at least 2 players.');
  Object.assign(room, { status: 'playing', order: ts, inventories: Object.fromEntries(ts.map(t => [t, START])), bids: {}, round: 1, pot: START,
    lastResult: null, history: [], winners: [], torpedo: false, taunts: {}, scoresRecorded: false, market: rollMarket(random), effects: [], earned: {} });
  broadcast(room);
}

const actions = {
  create(b, token) {
    const code = newCode();
    rooms.set(code, { code, hostToken: token, status: 'lobby', players: {}, order: [], inventories: {}, bids: {}, round: 0, pot: 0, lastResult: null, history: [], winners: [], scoresRecorded: false, touched: Date.now(),
      shop: b.shop !== false, market: rollMarket(random), effects: [] });
    return actions.join({ ...b, code }, token);
  },
  join(b, token) {
    const room = rooms.get(String(b.code || '').toUpperCase());
    if (!room) throw new Error('No room with that code.');
    const nick = String(b.nick || '').trim().slice(0, 20) || 'Player';
    const hull = hullOf(b.hull), cabin = cabinOf(b.cabin), flag = flagOf(b.flag);
    if (!room.players[token]) room.players[token] = { token, id: rid(4), nick, hull, cabin, flag, joinedAt: Date.now() };
    else Object.assign(room.players[token], { nick, hull, cabin, flag });
    if (walletsRef && walletsRef.available) room.players[token].bling = walletsRef.get(token).worn;
    broadcast(room); return { code: room.code };
  },
  start(b, token, room) {
    if (room.hostToken !== token) throw new Error('Only the host can start the game.');
    if (room.status !== 'lobby') throw new Error('Game already running.');
    newGame(room);
  },
  // One tap from the end screen: a fresh game with everyone still in the room (leavers were removed).
  rematch(b, token, room) {
    if (room.hostToken !== token) throw new Error('Only the host can start a rematch.');
    if (room.status !== 'over') throw new Error('The game is not over yet.');
    newGame(room);
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
    Object.assign(room, { status: 'lobby', order: [], bids: {}, round: 0, lastResult: null, history: [], winners: [], torpedo: false, taunts: {}, effects: [], earned: {} });
    broadcast(room);
  },
  settings(b, token, room) {
    if (room.hostToken !== token) throw new Error('Only the host can change that.');
    if (room.status !== 'lobby') throw new Error('Change it in the lobby.');
    room.shop = b.shop !== false;
    broadcast(room);
  },
  leave(b, token, room) {
    if (room.status === 'lobby' || room.status === 'over') { delete room.players[token]; if (room.hostToken === token) { const next = Object.keys(room.players)[0]; if (next) room.hostToken = next; } broadcast(room); }
  },
};

function readBody(req) {
  return new Promise((ok, fail) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { fail(e); } }); req.on('error', fail);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function createServer({ dataDir = process.env.DATA_DIR || '/data', logger = console, random: rnd } = {}) {
  random = rnd || Math.random;
  const stores = { scores: createLeaderboardStore({ dataDir, logger }), games: createGamesStore({ dataDir, logger }), wallets: createWalletsStore({ dataDir, logger }) };
  walletsRef = stores.wallets;
  // This server owns the rooms: start from what the last one saved, minus rooms idle past their TTL.
  const roomStore = createJsonFileStore({ dataDir, file: 'rooms.json', label: 'rooms', clean: cleanRoom, logger,
    unavailableMessage: 'Room storage is unavailable.' });
  rooms.clear(); streams.clear();
  const roomsReady = Promise.all([roomStore.ready, stores.wallets.ready]).then(() => {
    const cut = Date.now() - ROOM_TTL;
    for (const r of roomStore.rows()) if (r.touched >= cut) rooms.set(r.code, r);
  });
  let saveTimer = null;
  const flush = async () => {
    clearTimeout(saveTimer); saveTimer = null;
    await stores.wallets.flush();
    await roomsReady;
    if (!roomStore.available) return;
    await roomStore.update(() => [...rooms.values()]).catch(e => logger.error('[rooms] save failed:', e.message));
  };
  scheduleSave = () => { if (!saveTimer) saveTimer = setTimeout(flush, 250); };
  const server = http.createServer(async (req, res) => {
    await roomsReady;
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(indexFor(req, url)); }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/') && serveAsset(res, url.pathname)) return;
    if (req.method === 'GET' && url.pathname === '/digits.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      return res.end(DIGITS);
    }
    if (req.method === 'GET' && url.pathname === '/api/shop') return json(res, 200, { catalog: CATALOG, emotes: EMOTES });
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
  server.flush = flush; // save rooms now (on shutdown, and in tests)
  return server;
}

// Forget rooms idle for 12 hours.
setInterval(() => { const cut = Date.now() - ROOM_TTL; let gone = false; for (const [c, r] of rooms) if (r.touched < cut) { rooms.delete(c); gone = true; } if (gone) scheduleSave(); }, 3600e3).unref();

if (require.main === module) {
  const server = createServer().listen(PORT, '0.0.0.0', () => console.log('Puerto Banana on :' + PORT));
  // Fly sends SIGINT/SIGTERM before stopping a machine (deploys, idle stops): save the rooms first.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.flush().finally(() => process.exit(0)));
}
module.exports = { createServer };
