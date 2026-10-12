# Rivals Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save every finished game and show a home-page line chart of win rate over time for the viewer and their rivals, coloured by ship hull.

**Architecture:**
- The safe-saving logic in `leaderboard-store.js` moves into a shared `json-file-store.js`. A new `games-store.js` uses it to save each finished game to `games.json`.
- A pure function in `rivals.js` turns the saved games into chart series. `server.js` exposes it as `GET /api/rivals?name=…`.
- `index.html` draws the chart as inline SVG with a tappable legend. No new dependencies.

**Tech Stack:** Node 20+ built-ins only (`http`, `fs/promises`, `assert/strict`). The client is plain HTML, CSS and JS in `index.html`. Tests are plain Node scripts run by `npm test`.

**Spec:** `docs/superpowers/specs/2026-10-12-rivals-chart-design.md`

## Global Constraints

- Zero runtime dependencies. Node 20+, built-ins only. The chart is hand-written SVG; no chart libraries.
- `games.json` lives in `DATA_DIR` (Fly volume `/data`) and keeps the newest **5,000** games.
- Players are matched by name: trimmed, inner whitespace collapsed to one space, lowercased.
- The chart shows the viewer plus up to 5 rivals (**6** players max), or the 6 most active players as a fallback.
- The x-axis is the newest **100** games involving shown players. Rates count **all** history. A player's line starts at their **3rd** game.
- The server answers `503 { "error": "Game history unavailable." }` when history storage is unreadable. Gameplay, `/healthz` and the harbour log are unaffected.
- Copy, verbatim from the spec:
  - Headings: "You and your rivals", "Most active captains".
  - Legend: "7 of 12 won · 58%".
  - Loading: "Charting the rivalry…"
  - Unavailable: "The rivalry chart can't be read right now. You can still play."
  - No games: "No voyages logged yet. Finish a game to start the chart."
  - Under 3 games: "Lines appear from each captain's 3rd game."
- Mobile-first: works at 320px with no horizontal scroll, tap targets at least 44px, light and dark mode, names always escaped.
- The harbour log's behaviour and every existing test stay unchanged.
- **Commits:** the user's CLAUDE.md says to ask before committing. Get the user's okay for per-task local commits before starting. Never push or deploy without asking; pushing `main` deploys to Fly.

## Review Focus

1. **Names with quotes or HTML** (`O'Neil`, `<b>Cap</b>`): the legend must show them literally and the highlight toggle must still work. *(Task 3 test; Task 5 toggles by index, never by name in `onclick`.)*
2. **The same captain typed differently** ("Anna", " anna ", "ANNA"): one line, labelled with the latest spelling. *(Task 3 test.)*
3. **A viewer with no history, or an empty name:** the fallback chart, never an error. *(Task 3 and Task 4 tests.)*
4. **Tied winners:** every tied winner counts the game as a win. *(Task 3 test.)*
5. **Games saved out of time order** (manual edit or clock change): the chart is still chronological. *(Task 3 test.)*

---

## File structure

| File | Responsibility |
|---|---|
| `json-file-store.js` (new) | One durable JSON-array file: tolerant load, `update(fn)` with serialised atomic writes |
| `leaderboard-store.js` (modify) | Top-20 harbour log on top of `json-file-store` (behaviour unchanged) |
| `players.js` (new) | Shared player rules: `HULLS`, `hullOf`, `nameKey`, `NAME_MAX` |
| `games-store.js` (new) | Finished-game history (newest 5,000) on top of `json-file-store` |
| `games-store.test.js` (new) | Store tests |
| `rivals.js` (new) | Pure `computeRivals(games, name)` → chart response |
| `rivals.test.js` (new) | Rivals maths tests |
| `server.js` (modify) | Record each game in both stores; `GET /api/rivals` |
| `server.test.js` (modify) | End-to-end history and API tests |
| `index.html` (modify) | Load, draw and toggle the rivals chart |
| `package.json` (modify) | Add the new test files to `npm test` |

---

### Task 1: Extract the shared JSON file store

**Files:**
- Create: `json-file-store.js`
- Modify: `leaderboard-store.js` (whole file)
- Test: `leaderboard-store.test.js` (unchanged; it is the regression suite for this refactor)

**Interfaces:**
- Produces: `createJsonFileStore({ dataDir, file, label, clean, normalize, logger, unavailableMessage })`. It returns `{ ready: Promise<void>, available: boolean, accept(rows, source) => cleanRows, rows() => currentArray, update(fn: rows => nextRows) => Promise<void> }`.
- Produces: `createLeaderboardStore`, unchanged public API: `{ ready, available, logger, list(), record(entries) }`.

- [ ] **Step 1: Confirm the regression suite passes before touching anything**

Run: `node leaderboard-store.test.js`
Expected: every line `ok`, last line `all pass`.

- [ ] **Step 2: Create `json-file-store.js`**

```js
// One durable JSON-array file: tolerant load, serialized atomic writes (temp file + rename).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// clean(row) -> clean row or null; normalize(rows) -> rows to keep (sorted/capped); runs on load and every write.
function createJsonFileStore({ dataDir, file, label, clean, normalize = rows => rows, logger = console, unavailableMessage }) {
  const full = path.join(dataDir, file);
  let rows = [];
  let chain = Promise.resolve();
  const store = { available: true, logger };

  store.accept = (list, source) => {
    const good = [];
    for (const r of list) { const c = clean(r); if (c) good.push(c); else logger.error(`[${label}] discarded malformed ${source} row:`, JSON.stringify(r)); }
    return good;
  };

  store.ready = (async () => {
    let text;
    try { text = await fs.readFile(full, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return;
      store.available = false;
      logger.error(`[${label}] storage unavailable (${full}):`, e.message);
      return;
    }
    try {
      const list = JSON.parse(text);
      if (!Array.isArray(list)) throw new Error('not an array');
      rows = normalize(store.accept(list, 'stored'));
    } catch (e) {
      logger.error(`[${label}] ${full} is corrupt (${e.message}); starting empty, next save replaces it`);
    }
  })();

  store.rows = () => rows;

  // fn(currentRows) -> nextRows. Writes run one at a time; a failed write keeps the previous rows.
  store.update = fn => {
    const run = chain.then(async () => {
      await store.ready;
      if (!store.available) throw new Error(unavailableMessage);
      const next = normalize(fn(rows));
      const tmp = path.join(dataDir, `.${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(next, null, 1));
        await fs.rename(tmp, full);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        logger.error(`[${label}] save failed:`, e.message);
        throw e;
      }
      rows = next;
    });
    chain = run.catch(() => {}); // a failed write must not block later ones
    return run;
  };

  return store;
}

module.exports = { createJsonFileStore };
```

- [ ] **Step 3: Rewrite `leaderboard-store.js` on top of it**

Replace the whole file with:

```js
// Durable top-20 leaderboard on a shared JSON-file store.
const { createJsonFileStore } = require('./json-file-store');

const FILE = 'highscores.json', LIMIT = 20, NAME_MAX = 20;

const rank = (a, b) => b.score - a.score || Date.parse(a.completedAt) - Date.parse(b.completedAt);

// A clean public record, or null if the row is not one.
function clean(e) {
  if (!e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.completedAt !== 'string') return null;
  if (!Number.isSafeInteger(e.score) || e.score < 0 || Number.isNaN(Date.parse(e.completedAt))) return null;
  return { name: e.name.slice(0, NAME_MAX), score: e.score, completedAt: new Date(e.completedAt).toISOString() };
}

function createLeaderboardStore({ dataDir = process.env.DATA_DIR || '/data', logger = console } = {}) {
  const top = rows => rows.slice().sort(rank).slice(0, LIMIT);
  const base = createJsonFileStore({ dataDir, file: FILE, label: 'highscores', clean, normalize: top, logger,
    unavailableMessage: 'Highscore storage is unavailable.' });
  return {
    get available() { return base.available; },
    logger,
    ready: base.ready,
    list: () => base.rows().map(e => ({ ...e })),
    record: newEntries => base.update(rows => rows.concat(base.accept(newEntries, 'new'))),
  };
}

module.exports = { createLeaderboardStore };
```

- [ ] **Step 4: Run the whole suite; behaviour must be identical**

Run: `npm test`
Expected: three `all pass` lines (`test.js`, `leaderboard-store.test.js`, `server.test.js`).

- [ ] **Step 5: Commit** (with the user's okay)

```bash
git add json-file-store.js leaderboard-store.js
git commit -m "Extract the durable JSON-file store from the leaderboard"
```

---

### Task 2: Shared player rules and the games store

**Files:**
- Create: `players.js`, `games-store.js`, `games-store.test.js`
- Modify: `server.js` (top of file: remove local `HULLS`/`hullOf`, import from `players.js`)
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `createJsonFileStore` (Task 1).
- Produces: `players.js` exports `{ HULLS: string[], hullOf(h) => string, nameKey(s) => string, NAME_MAX: 20 }`.
- Produces: `createGamesStore({ dataDir, logger })` → `{ ready, available, logger, list() => Game[] (oldest first, copies), record(game) => Promise<void> }`. Here `Game = { completedAt: ISO string, players: [{ name, key, score, won: boolean, hull }] }`, and `KEEP = 5000`.

- [ ] **Step 1: Write the failing tests**

Create `games-store.test.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node games-store.test.js`
Expected: crash with `Cannot find module './games-store'`.

- [ ] **Step 3: Create `players.js`**

```js
// Shared player rules: ship hull colours and the name key that matches captains across games.
const HULLS = ['navy', 'coral', 'mango', 'hibiscus', 'palm', 'turquoise', 'purple', 'charcoal'];
const hullOf = h => HULLS.includes(h) ? h : 'navy';
const NAME_MAX = 20;
// "  Anna   Bell " and "anna bell" are the same captain.
const nameKey = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

module.exports = { HULLS, hullOf, nameKey, NAME_MAX };
```

- [ ] **Step 4: Create `games-store.js`**

```js
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
```

- [ ] **Step 5: Make `server.js` use the shared hull rules**

In `server.js`, replace these lines:

```js
// Ship hull colours players can pick; the client maps each key to a colour. Anything else becomes navy.
const HULLS = ['navy', 'coral', 'mango', 'hibiscus', 'palm', 'turquoise', 'purple', 'charcoal'];
const hullOf = h => HULLS.includes(h) ? h : 'navy';
```

with:

```js
const { hullOf } = require('./players'); // hull keys; the client maps each to a colour
```

- [ ] **Step 6: Add the new tests to `npm test`**

In `package.json`, set the test script to:

```json
"test": "node test.js && node leaderboard-store.test.js && node games-store.test.js && node server.test.js"
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: four `all pass` lines.

- [ ] **Step 8: Commit** (with the user's okay)

```bash
git add players.js games-store.js games-store.test.js server.js package.json
git commit -m "Add the finished-games store and shared player rules"
```

---

### Task 3: Rivals maths

**Files:**
- Create: `rivals.js`, `rivals.test.js`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `nameKey` from `players.js`; `Game` records shaped as in Task 2.
- Produces: `computeRivals(games: Game[], name: string)`, which returns:

  ```
  { mode: 'rivals'|'active', me: string|null, games: ISO string[],
    players: [{ key, name, hull, played, won, points: [windowIndex, rate0to1][] }] }
  ```

  `players` is sorted by win rate (highest first), then games played (most first), then key.
- Also exports `{ SHOW: 6, WINDOW: 100, FIRST_POINT: 3 }`.

- [ ] **Step 1: Write the failing tests**

Create `rivals.test.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node rivals.test.js`
Expected: crash with `Cannot find module './rivals'`.

- [ ] **Step 3: Create `rivals.js`**

```js
// Win-rate lines for the rivals chart, computed from saved games.
const { nameKey } = require('./players');

const SHOW = 6, WINDOW = 100, FIRST_POINT = 3;

// Keys of a Map<key, {n, last}> ordered by n desc, then most recent game desc.
const ranked = (m, field) => [...m.entries()].sort((x, y) => y[1][field] - x[1][field] || y[1].last - x[1].last).map(([k]) => k);

function computeRivals(games, name) {
  const me = nameKey(name) || null;
  const list = games.slice().sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));

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
```

- [ ] **Step 4: Add it to `npm test` and run**

In `package.json`, set the test script to:

```json
"test": "node test.js && node leaderboard-store.test.js && node games-store.test.js && node rivals.test.js && node server.test.js"
```

Run: `npm test`
Expected: five `all pass` lines. If the `rivals:` test fails on ordering, the most likely cause is the `ranked` tie-break comparing `last` the wrong way round. More recent (higher index) must sort first.

- [ ] **Step 5: Commit** (with the user's okay)

```bash
git add rivals.js rivals.test.js package.json
git commit -m "Compute rivals win-rate lines from saved games"
```

---

### Task 4: Record games and serve `/api/rivals`

**Files:**
- Modify: `server.js`. Touch:
  - the requires at the top;
  - `resolveRound`;
  - `recordScores`, which becomes `recordGame`;
  - the `bid` and `skip` actions;
  - `createServer` and its routes.
- Test: `server.test.js`

**Interfaces:**
- Consumes: `createGamesStore` (Task 2), `computeRivals` (Task 3), `createLeaderboardStore` (Task 1).
- Produces:
  - `GET /api/rivals?name=<name>` → `200` with the `computeRivals` response, or `503 { error: 'Game history unavailable.' }`.
  - Inside the server, actions receive `stores = { scores, games }` where they previously received `store`.

- [ ] **Step 1: Write the failing tests**

In `server.test.js`, add a helper under `const scores = …`:

```js
const rivals = (port, name) => request(port, 'GET', '/api/rivals' + (name === undefined ? '' : '?name=' + encodeURIComponent(name)));
```

Add these tests to the `tests` object:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node server.test.js`
Expected: the three new tests `FAIL`. `/api/rivals` returns 404, so `r.body` is null or the status is 404. The existing tests stay `ok`.

- [ ] **Step 3: Wire the stores in `server.js`**

At the top, under `const { createLeaderboardStore } = require('./leaderboard-store');`, add:

```js
const { createGamesStore } = require('./games-store');
const { computeRivals } = require('./rivals');
```

Replace the whole `recordScores` function, including its comment, with:

```js
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
```

Then rename the parameter `store` to `stores` in these places, keeping everything else as is:
- `function resolveRound(room, store)` → `function resolveRound(room, stores)`, and inside it `recordScores(room, store);` → `recordGame(room, stores);`
- `bid(b, token, room, store)` → `bid(b, token, room, stores)`, and inside it `resolveRound(room, store)` → `resolveRound(room, stores)`
- `skip(b, token, room, store)` → `skip(b, token, room, stores)`, and inside it `resolveRound(room, store)` → `resolveRound(room, stores)`

In `createServer`, replace `const store = createLeaderboardStore({ dataDir, logger });` with:

```js
  const stores = { scores: createLeaderboardStore({ dataDir, logger }), games: createGamesStore({ dataDir, logger }) };
```

Replace the `/api/highscores` route body and add the rivals route right after it:

```js
    if (req.method === 'GET' && url.pathname === '/api/highscores') {
      await stores.scores.ready;
      return stores.scores.available ? json(res, 200, stores.scores.list()) : json(res, 503, { error: 'Highscores unavailable.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/rivals') {
      await stores.games.ready;
      if (!stores.games.available) return json(res, 503, { error: 'Game history unavailable.' });
      return json(res, 200, computeRivals(stores.games.list(), url.searchParams.get('name') || ''));
    }
```

In the POST `/api` route, change `fn(b, token, room, store)` to `fn(b, token, room, stores)`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: five `all pass` lines. Run `grep -n "store\b" server.js` and check that no bare `store` references remain outside comments.

- [ ] **Step 5: Commit** (with the user's okay)

```bash
git add server.js server.test.js
git commit -m "Save every finished game and serve /api/rivals"
```

---

### Task 5: The rivals chart on the home page

**Files:**
- Modify: `index.html`. Touch:
  - the CSS (add a block after the `/* Harbour log` rules);
  - the client state `S`;
  - the harbour-log loader section (add `loadRivals`);
  - `dropRoom`, `onChange`, the startup lines at the bottom;
  - the `nick` input in `homeView`;
  - `homeView`'s tail (add `rivalsView()`).

**Interfaces:**
- Consumes: `GET /api/rivals?name=` (Task 4), plus the existing client helpers `HULLS` (key → `[label, hex]`), `esc`, `render`, `S`.
- Produces: `loadRivals()`, `queueRivals()`, `rivalColors(players)`, `rivalsChart(d, colors)`, `rivalsView()`, `toggleRival(i)`.

- [ ] **Step 1: Add the state and the loader**

In the `const S = { … }` line, add `rivals: null, rivalHi: null,` after `scores: null,`.

Directly after the `loadScores` function, add:

```js
// ---------- rivals chart (game history) ----------
// S.rivals: null = loading, object = loaded, 'error' = unavailable. Never blocks rooms.
async function loadRivals() {
  try {
    const r = await fetch('/api/rivals?name=' + encodeURIComponent(S.nick.trim()));
    if (!r.ok) throw new Error();
    const d = await r.json();
    S.rivals = d && Array.isArray(d.players) ? d : 'error';
  } catch (e) { S.rivals = 'error'; }
  if (!S.code || !S.room) render();
}
let rivalsTimer;
function queueRivals() { clearTimeout(rivalsTimer); rivalsTimer = setTimeout(loadRivals, 600); } // after typing a name
function toggleRival(i) { const k = S.rivals.players[i].key; S.rivalHi = S.rivalHi === k ? null : k; render(); }
```

- [ ] **Step 2: Load it wherever the harbour log loads**

- In `dropRoom`, change `loadScores(); }` at its end to `loadScores(); loadRivals(); }`.
- In `onChange`, change `setTimeout(loadScores, 600);` to `setTimeout(() => { loadScores(); loadRivals(); }, 600);`.
- At the bottom startup lines, change `loadScores();` to `loadScores();\nloadRivals();`.
- In `homeView`'s `nick` input, change `oninput="S.nick=this.value;ls.set('pb_nick',this.value)"` to `oninput="S.nick=this.value;ls.set('pb_nick',this.value);queueRivals()"`.

- [ ] **Step 3: Add the chart and view functions**

Directly before `function logView() {`, add:

```js
// Each line takes its captain's hull colour; a clash gets the first colour nobody in the chart uses.
function rivalColors(players) {
  const used = new Set(), out = {};
  for (const p of players) {
    const k = HULLS[p.hull] && !used.has(p.hull) ? p.hull : Object.keys(HULLS).find(h => !used.has(h)) || 'navy';
    used.add(k); out[p.key] = HULLS[k][1];
  }
  return out;
}
function rivalsChart(d, colors) {
  const W = 340, H = 200, L = 34, R = 330, T = 16, B = 172, n = d.games.length;
  const X = i => L + (n > 1 ? i * (R - L) / (n - 1) : (R - L) / 2), Y = r => T + (1 - r) * (B - T);
  const day = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  let s = [0, 0.5, 1].map(r => `<line class="rv-grid" x1="${L}" x2="${R}" y1="${Y(r)}" y2="${Y(r)}"/>`
    + `<text class="rv-tick" x="${L - 6}" y="${Y(r) + 4}" text-anchor="end">${r * 100}%</text>`).join('');
  s += `<text class="rv-tick" x="${L}" y="${H - 6}">${esc(day(d.games[0]))}</text>`
    + `<text class="rv-tick" x="${R}" y="${H - 6}" text-anchor="end">${esc(day(d.games[n - 1]))}</text>`;
  for (const p of d.players.slice().reverse()) { // leader drawn last, on top
    if (!p.points.length) continue;
    const cls = 'rv-line' + (p.key === d.me ? ' rv-me' : '') + (S.rivalHi && S.rivalHi !== p.key ? ' rv-faded' : '');
    const path = p.points.map(([i, r], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(r).toFixed(1)}`).join('');
    const [li, lr] = p.points[p.points.length - 1];
    s += `<g class="${cls}" style="--c:${colors[p.key]}"><path d="${path}"/><circle cx="${X(li).toFixed(1)}" cy="${Y(lr).toFixed(1)}" r="4.5"/></g>`;
  }
  const lead = d.players[0];
  return `<svg class="rv-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Win rate chart. ${esc(lead.name)} leads with ${Math.round(lead.won / lead.played * 100)}% of ${lead.played} games won.">${s}</svg>`;
}
function rivalsView() {
  const d = S.rivals;
  let body;
  if (d === null) body = `<p class="muted">Charting the rivalry…</p>`;
  else if (d === 'error') body = `<p class="muted">The rivalry chart can't be read right now. You can still play.</p>`;
  else if (!d.players.length) body = `<p class="muted">No voyages logged yet. Finish a game to start the chart.</p>`;
  else {
    const colors = rivalColors(d.players), anyLine = d.players.some(p => p.points.length);
    // Chips toggle by index: names may contain quotes, so they never go inside onclick.
    body = `<div class="card">${anyLine ? rivalsChart(d, colors) : `<p class="muted small">Lines appear from each captain's 3rd game.</p>`}
      <ul class="rv-legend">${d.players.map((p, i) => `<li><button class="rv-chip" aria-pressed="${S.rivalHi === p.key}" onclick="toggleRival(${i})">
        <span class="rv-dot" style="background:${colors[p.key]}"></span><span class="rv-name">${esc(p.name)}${p.key === d.me ? ' (you)' : ''}</span>
        <span class="rv-stat">${p.won} of ${p.played} won · ${Math.round(p.won / p.played * 100)}%</span></button></li>`).join('')}</ul></div>`;
  }
  const title = d && d !== 'error' && d.mode === 'active' ? 'Most active captains' : 'You and your rivals';
  return `<section class="rivals" aria-labelledby="rv-h"><h2 id="rv-h">Rivals</h2><p class="muted small">${title} · win rate game by game</p><div aria-live="polite">${body}</div></section>`;
}
```

- [ ] **Step 4: Put it on the home page**

In `homeView`, change the final `${logView()}` to:

```js
  ${rivalsView()}
  <div class="divider"></div>
  ${logView()}
```

- [ ] **Step 5: Add the styles**

After the last `.log …` CSS rule (`.log .score{…}`), add:

```css
/* Rivals chart: win rate per captain, each line in its hull colour */
.rivals h2{margin-bottom:4px}
.rv-chart{display:block;width:100%;height:auto;margin:0 0 6px}
.rv-grid{stroke:var(--line);stroke-width:1}
.rv-tick{fill:var(--muted);font:600 11px Figtree,system-ui,sans-serif}
.rv-line path{fill:none;stroke:var(--c);stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}
.rv-line circle{fill:var(--c);stroke:var(--surface);stroke-width:2}
.rv-me path{stroke-width:3.6}
.rv-faded{opacity:.15}
.rv-legend{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.rv-chip{width:100%;display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:10px;align-items:center;min-height:44px;padding:0 12px;border-radius:12px;font-weight:600;text-align:left;box-shadow:inset 0 0 0 1px var(--line)}
.rv-chip[aria-pressed="true"]{box-shadow:inset 0 0 0 3px var(--ink)}
.rv-dot{width:12px;height:12px;border-radius:50%}
.rv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-stat{font-size:.85rem;color:var(--muted);font-weight:600}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: five `all pass` lines.

- [ ] **Step 7: Seed history and check it in the browser**

Seed a throwaway data dir, **not** `./data`. Run this from the repo root:

```bash
export D=$(mktemp -d)
node -e '
const fs=require("fs"),p=process.argv[1];fs.mkdirSync(p,{recursive:true});
const names=[["Captain","coral"],["Anna","palm"],["Bo","purple"],["Cleo","coral"],["Dex","turquoise"],["<b>O'"'"'Neil</b>","mango"]];
const g=[];for(let i=0;i<40;i++){const a=names[i%6],b=names[(i*7+1)%6];if(a===b)continue;const w=(i*13)%3!==0;
g.push({completedAt:new Date(Date.UTC(2026,8,1+i)).toISOString(),players:[{name:a[0],score:w?210:60,won:w,hull:a[1]},{name:b[0],score:w?60:210,won:!w,hull:b[1]}]});}
fs.writeFileSync(p+"/games.json",JSON.stringify(g));' "$D"
```

Start `DATA_DIR=$D node server.js` (or the preview server with that `DATA_DIR`), open `http://localhost:8080` and set the name to "Captain". Check:
- At 390×844 and at 320px wide: the chart and legend fit with no horizontal scroll (`document.documentElement.scrollWidth === innerWidth`).
- Cleo's line is not coral, because Captain took coral: the colour-clash rule.
- `<b>O'Neil</b>` shows as literal text, and tapping its chip highlights its line while the others fade. Tapping it again clears the highlight.
- Dark mode (emulate `prefers-color-scheme: dark`): gridlines, ticks and lines stay readable.
- Rename to "Nobody": after about 0.6s the heading changes to "Most active captains".
- Stop the server, then run it with an empty `DATA_DIR`: the page shows "No voyages logged yet. Finish a game to start the chart."
- Make `games.json` a directory in that `DATA_DIR`: the page shows "The rivalry chart can't be read right now. You can still play." and creating a room still works.

- [ ] **Step 8: Commit** (with the user's okay)

```bash
git add index.html
git commit -m "Show the rivals win-rate chart on the home page"
```
