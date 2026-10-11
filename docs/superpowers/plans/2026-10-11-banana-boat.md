# Puerto Banana Banana-Boat Theme and Highscores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retheme Puerto Banana as a mobile-first banana boat game, preserve a player’s local name, and add a public top-20 leaderboard persisted on a Fly volume.

**Architecture:** Keep the zero-dependency Node server and single HTML client. Add an injectable JSON-file leaderboard store using atomic writes under `/data`, record completed-room winners once from authoritative server state, expose a read-only API, and load it independently on the home screen. Mount a single Fly volume in the existing single-machine deployment; keep rooms in memory.

**Tech Stack:** Node.js built-ins (http, fs/promises, path, os, assert); HTML/CSS/vanilla JavaScript; Fly.io Machines and volumes; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-11-banana-boat-design.md`

## Global Constraints

- Retain the zero-dependency HTML/CSS/JavaScript architecture.
- Use `/data` for persistent data on Fly, and keep one app machine; do not claim volume replication.
- Store only public winner display name, final score, and server-generated completion timestamp; no tokens or room codes.
- Limit the public leaderboard to the best 20 entries, sorted by score descending and completion time ascending.
- Keep storage access guarded in the browser; preserve the existing `pb_nick` key.
- Keep game play available if leaderboard storage is unavailable, and keep `/healthz` independent of it.
- Support 320px and 390–400px mobile widths, safe areas, reduced motion, visible focus, and minimum 44px controls.
- Do not change auction rules or add runtime dependencies.

## Review Focus

- Storage directory or JSON file is missing, malformed, read-only, or full → the server continues serving the game and health endpoint; leaderboard errors are logged and no false success is reported.
- Concurrent game completions or store writes → each accepted result is durably serialized without truncating existing entries.
- A room already over, or an SSE reconnect after completion → no duplicate score entries are recorded.
- A player name contains HTML/control characters or is empty → API data is bounded and client rendering does not interpret it as markup.
- The Fly volume is absent on initial deployment or the machine is recreated → deployment idempotently provisions the expected volume and attaches it without scaling to multiple machines.

---

### Task 1: Durable leaderboard store

**Files:**
- Create: `leaderboard-store.js`
- Create: `leaderboard-store.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces `createLeaderboardStore({ dataDir, logger })`, returning `{ ready, list(), record(entries) }`.
- `ready` resolves after an existing `highscores.json` is read/validated or an empty store is initialized in memory; an unavailable directory/file is logged but does not reject server startup.
- `list()` returns a copy of at most 20 public records in ranking order.
- `record(entries)` accepts server-created entries shaped `{ name: string, score: integer, completedAt: ISOString }`, serializes writes, and resolves only after atomic persistence. It rejects on write failure without pretending the entries were saved.

- [ ] **Step 1: Add store tests for empty/read/validation/ranking**

Create `leaderboard-store.test.js` with Node `assert/strict`, `fs/promises`, `os`, and `path`. Use a fresh `fs.mkdtemp(path.join(os.tmpdir(), 'pb-scores-'))` directory per test and remove it in `finally`. Assert an empty store returns `[]`; seed a JSON array with 25 valid records and assert `list()` returns 20 sorted by score descending, then timestamp ascending; assert invalid/corrupt JSON logs an error and yields an empty list without rejecting `ready`; assert HTML-looking names remain literal data.

- [ ] **Step 2: Run store tests to verify they fail**

Run: `node leaderboard-store.test.js`
Expected: FAIL because `leaderboard-store.js` does not exist.

- [ ] **Step 3: Implement the file-backed store**

Implement `createLeaderboardStore({ dataDir = process.env.DATA_DIR || '/data', logger = console } = {})`. Read `highscores.json` during `ready`, validate each record’s exact fields and types, clamp names to 20 characters, non-negative safe integer score, and parseable timestamp, discard malformed rows with a log entry, and sort/truncate. If initial read fails for `ENOENT`, start empty; for other errors, log and start empty but mark storage unavailable so writes reject. For each `record`, add valid entries to a serialized promise chain, sort/truncate, create the data directory recursively, write JSON to a unique temp file in the same directory, then rename it over `highscores.json`; update in-memory data only on successful rename, clean up temp files on failure, and log/reject failures. Return defensive copies from `list()`.

- [ ] **Step 4: Run store tests to verify they pass**

Run: `node leaderboard-store.test.js`
Expected: PASS for empty data, malformed data handling, rank ordering, top-20 truncation, bounded records, literal names, and atomic-file persistence.

- [ ] **Step 5: Add serialization and restart tests**

Extend tests to queue concurrent `record()` calls and assert all successful entries survive; create a second store over the same directory and assert the same ordered results are loaded. Force a write failure using a non-writable/unusable target and assert `record()` rejects while the previous readable contents remain unchanged.

- [ ] **Step 6: Run all store tests**

Run: `node leaderboard-store.test.js`
Expected: PASS.

- [ ] **Step 7: Add the store test to the package test script**

Change `package.json` test script to `node test.js && node leaderboard-store.test.js`.

---

### Task 2: Server API and exactly-once winner recording

**Files:**
- Modify: `server.js`
- Create: `server.test.js`
- Modify: `package.json`

**Interfaces:**
- `createServer({ dataDir, logger } = {})` creates and returns an HTTP server with its leaderboard store attached for integration tests; normal `node server.js` startup listens on `PORT`.
- `GET /api/highscores` responds with `200 application/json` and the store’s public record array, or `503 {"error":"Highscores unavailable."}` if storage cannot be read.
- Completion records come only from server-owned room state; one entry is generated per winner, with the winner’s room nickname and final banana inventory.

- [ ] **Step 1: Write integration tests for endpoint and completion behavior**

Create `server.test.js` using Node built-ins and a temp data directory. Start the exported server on port `0`, use `server.address().port`, and close/remove the temp directory in `finally`. Test empty `GET /api/highscores`; create/join two players using valid 32-char hex tokens; start a game; submit bids through `POST /api`; force a completion by playing rounds with bids sufficient for a winner; verify scores returned match authoritative final inventories; verify tied winners each appear; verify an attempted client-provided score is ignored; and re-read after all completion-triggered broadcasts to assert one entry per winner only. Add assertions for health status if storage is unavailable.

- [ ] **Step 2: Run server integration test to verify it fails**

Run: `node server.test.js`
Expected: FAIL because server does not export an injectable server or serve the leaderboard endpoint.

- [ ] **Step 3: Refactor server startup for testable injection**

Keep current module behavior when executed directly. Construct the store through `createLeaderboardStore`, let HTTP handler await `store.ready` before leaderboard reads, add `GET /api/highscores`, and export `createServer`. Continue returning `/healthz` without waiting on store availability. Preserve other routes and game action behavior.

- [ ] **Step 4: Record a completed game once from authoritative state**

Initialize each room with `scoresRecorded: false`. In the code path after round resolution changes status to `over`, generate winner entries from `room.winners`, `room.players[token].nick`, and `room.inventories[token]`; call store `record()` exactly once, set the marker before starting the async write to block duplicate attempts, and log write errors without breaking round resolution/broadcasting. Do not add entries from lobby reset, API arguments, or repeated SSE writes. Keep failure explicit in server logs and do not represent it as persisted if the store rejects.

- [ ] **Step 5: Run integration tests and existing auction tests**

Run: `node server.test.js && node test.js && node leaderboard-store.test.js`
Expected: PASS; auction rules remain unchanged.

- [ ] **Step 6: Add API tests for input and storage failures**

Assert the API ignores forged `name`, `score`, and `completedAt` request fields; a directory that cannot be written still permits `/healthz`, room creation, and joining; leaderboard reads return the documented unavailable response; names are limited to the selected room nickname.

- [ ] **Step 7: Run all Node tests**

Run: `npm test`
Expected: PASS for rule engine, store, and HTTP integration suites.

---

### Task 3: Mobile banana-boat interface and home leaderboard

**Files:**
- Modify: `index.html`

**Interfaces:**
- Client fetches `GET /api/highscores` independently from room auto-rejoin; failures affect only the leaderboard panel.
- Public entries render from `{ name, score, completedAt }`; all untrusted names are escaped using existing `esc()`.

- [ ] **Step 1: Keep existing name memory contract and define visual breakpoints**

Preserve `ls.get('pb_nick')` initialization and the guarded localStorage wrapper. Add a small visual QA checklist in comments near responsive rules: 320px and 390px widths, safe-area insets, visible focus, and 44px minimum controls. No new storage key or external asset is needed.

- [ ] **Step 2: Rebuild the global styling around a banana boat at sea**

Replace the current palette and layout styles with a cohesive responsive system: dark ocean surface and light sand/deck surfaces, banana-yellow actions, warm cargo/rope accents, CSS-only wave/deck details, layered water/deck atmosphere, and readable contrast. Retain system light/dark preference. Give controls `min-height:44px`, ensure `#app` has 16px minimum side gutters and safe-area-aware vertical padding, let rows wrap/stack on narrow widths, avoid horizontal overflow at 320px, and keep reduced-motion and focus styles. Keep the design CSS-only and dependency-free.

- [ ] **Step 3: Retheme the home and highscore list**

Add a compact brand hero that suggests a banana cargo vessel on the water; retain name, create, join, and rules controls. Add a leaderboard section with an `aria-live="polite"` loading state, explicit empty/unavailable states, rank, escaped player name, score, and a readable completion date. Fetch leaderboard once on page startup using a dedicated async function and refresh it after game completion/return to home; do not block room create/join or auto-rejoin. Keep name saving in `connect()` and make it save on home name input so the preference survives before joining.

- [ ] **Step 4: Retheme game, lobby, reveal, and winner views**

Update existing markup/classes, retaining all existing actions and game rules. Make the pot feel like cargo aboard ship, distinguish the player’s stash, strengthen sealed-bid state and tap affordances, and maintain readable status/inventory rows on narrow devices. Keep sheet/dialog keyboard behavior, reduced-motion animation, and accessible labels.

- [ ] **Step 5: Run static and browser-width checks**

Run `npm test`. Start the server locally and inspect with browser devtools or automated browser if available at 320px, 390px, and desktop widths. Verify name restoration after reload, leaderboard loading/empty/unavailable behavior, no horizontal page scrolling, 44px touch controls, focus visibility, light/dark rendering, and correct escaping of `<img src=x onerror=...>` as text. Do not add external fonts or assets.

---

### Task 4: Fly volume and deployment workflow

**Files:**
- Modify: `fly.toml`
- Modify: `.github/workflows/fly.yml`
- Modify: `README.md`

**Interfaces:**
- Fly mount source `pb_data` is mounted at `/data` in the existing `arn` region.
- GitHub Actions checks for an existing named volume before creating it, then uses the existing `fly deploy --remote-only --ha=false` path.

- [ ] **Step 1: Verify existing Fly volume CLI output shape**

Run: `fly volumes list --app puerto-banana --json` and inspect the result. Confirm whether the app already has a volume named `pb_data`; do not delete or recreate unrelated volumes.

- [ ] **Step 2: Add a single volume mount to Fly config**

Add `[[mounts]]` with `source = "pb_data"` and `destination = "/data"` to `fly.toml`; retain one VM, existing region, and existing machine sizing.

- [ ] **Step 3: Make workflow volume provisioning idempotent**

In `.github/workflows/fly.yml`, after ensuring the app exists and before deployment, check `flyctl volumes list --app "$APP" --json` for a volume whose `.name == "pb_data"`; if absent, run `flyctl volumes create pb_data --app "$APP" --region arn --size 1 --yes`. Keep `flyctl deploy --remote-only --ha=false`. Do not use multiple volume count or high-availability deployment flags.

- [ ] **Step 4: Document durable and ephemeral state**

Update README deployment notes: the leaderboard survives app restarts on its attached Fly volume; game rooms and active games remain in memory and may be lost on restart; volume data belongs to the single machine and is not replicated; no multi-machine scaling is supported.

- [ ] **Step 5: Validate configuration and workflow syntax**

Run `fly config validate -c fly.toml` if supported; otherwise inspect parsed config via `fly config show -c fly.toml`. Validate workflow YAML structure with available tooling or Ruby/Python standard library parser if present, and verify the workflow retains `--ha=false`. Do not create the Fly volume or deploy until the reviewed implementation is committed/pushed, because GitHub Actions performs provisioning/deploy.

---

### Task 5: Full verification and ship

**Files:**
- Review all changed files listed above.

- [ ] **Step 1: Run all automated tests**

Run: `npm test`
Expected: PASS, including auction rules, JSON store, and server HTTP integration tests.

- [ ] **Step 2: Run a local end-to-end smoke test**

Start with a fresh temporary data directory (`DATA_DIR=/tmp/pb-smoke-<unique>`), verify `GET /healthz`, `GET /api/highscores`, `GET /`, create/join two players, complete a game, and confirm persisted score records survive server restart against the same data directory. Remove only the temporary smoke-test directory created for this check.

- [ ] **Step 3: Inspect final diff and repository status**

Run `git diff --check`, inspect the full diff, confirm no dependency was added, confirm the app remains single-machine, and confirm only intended project/spec/plan files changed.

- [ ] **Step 4: Commit verified implementation**

Stage the spec, plan, source, tests, Fly config, workflow, and README. Commit with a concise message describing the theme and durable leaderboard. The user explicitly directed implementation and push to `main`; do not create an extra branch or deploy manually.

- [ ] **Step 5: Push to main**

Push the implementation commit to `origin main`; this triggers the repository’s GitHub Actions Fly deployment, which provisions `pb_data` if missing and deploys the single machine.

- [ ] **Step 6: Verify GitHub deployment and live health**

Use `gh run list`/`gh run watch` for the push-triggered run; report failure output without claiming success if it fails. On success, request `https://puerto-banana.fly.dev/healthz` and `https://puerto-banana.fly.dev/api/highscores`, and inspect the home page response. Verify no production score data is written during smoke tests.
