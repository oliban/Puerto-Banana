# Puerto Banana: Game History and Rivals Chart Design

**Date:** 2026-10-12
**Status:** Design approved in conversation (sections 1–3); awaiting written-spec review
**Project:** Puerto Banana, a zero-dependency multiplayer bluff-and-auction game

## Intent and success criteria

Let a group of friends see who is winning and losing over time. The home page shows a line chart of each player's win rate, game after game, for the viewer and the people they have played with. The harbour log (top 20 winning hauls) stays as it is.

Success means:

- Every finished game is saved with each player's name, final bananas, win or loss, and hull colour.
- A visitor sees their own line and their rivals' lines, coloured by ship hull colour, on the home page.
- The chart is readable on a 320px phone, in light and dark mode, and has text equivalents for screen readers.
- Saving or reading history can never block creating, joining or playing a game, and never affects the harbour log.

## Decisions made in conversation

| Question | Decision |
|---|---|
| What the graph tracks | Across games: a rivalry chart, not round-by-round within one game |
| Player identity | By name, ignoring case and surrounding/repeated whitespace |
| Metric | Win rate (wins ÷ games played so far) |
| Who is shown | The viewer plus everyone who has shared a game with them, max 6; fallback to the 6 most active players |
| Architecture | Approach A: the server stores games and computes chart series; the client only draws |
| Line colours | Each player's most recently used hull colour; clashes resolved on the client |

History starts when this ships. No earlier games were stored, and the harbour log is not back-filled into it.

## Design

### 1. Storage: `games.json`

When a game reaches `over`, the server records one game, using the same once-per-game guard (`room.scoresRecorded`) that protects the harbour log:

```json
{ "completedAt": "2026-10-12T12:00:00.000Z",
  "players": [ { "name": "Anna", "key": "anna", "score": 214, "won": true, "hull": "coral" },
               { "name": "Bo",   "key": "bo",   "score": 40,  "won": false, "hull": "navy" } ] }
```

- `players` contains only those in `room.order` (people who played), not spectators. Tied winners all have `won: true`.
- `key` is the name normalised for matching: trimmed, inner whitespace collapsed to one space, lowercased.
- `name` keeps the player's spelling, capped at 20 characters as today. `hull` passes through the existing `hullOf` validation.
- The file is a JSON array in `DATA_DIR` (the Fly volume at `/data`). It keeps the newest 5,000 games and drops older ones.
- Records are validated on load. Malformed rows are logged and discarded, matching how the harbour log treats them.
- History and harbour log are saved independently. A failure in either is logged with the room code and does not affect the other.

**Shared helper.** The atomic, serialised JSON-file logic now inside `leaderboard-store.js` (load with ENOENT/corrupt handling, temp-file write + rename, a promise chain so one failed write doesn't block later ones, an `available` flag) moves into `json-file-store.js`. `leaderboard-store.js` and a new `games-store.js` both use it. The leaderboard's public behaviour and its existing tests stay unchanged.

### 2. API: `GET /api/rivals?name=<name>`

The response is computed on each request from the in-memory game list.

1. `me` = normalised key of `name` (`null` if empty).
2. **Who is in the chart**
   - If `me` has played at least one game: `me` plus the players who shared the most games with `me`, up to 6 in total. Ties are broken by most recent shared game.
   - Otherwise: the 6 players with the most games, ties broken by most recent game. `mode` is then `"active"` instead of `"rivals"`.
3. **Timeline:** all saved games in which at least one shown player took part, in time order. The response includes only the newest 100 of these.
4. **Per player**
   - Running `played` and `won` counts across **all** saved games, so the visible window doesn't reset them.
   - One point per game they played within the window: `[gameIndexInWindow, winRate]`, with `winRate` a number from 0 to 1.
   - No point is emitted for a game where the player's running `played` count is below 3.
5. Response:

```json
{ "mode": "rivals", "me": "anna",
  "games": ["2026-10-01T…", "…"],
  "players": [ { "key": "anna", "name": "Anna", "hull": "coral", "played": 12, "won": 7,
                 "points": [[2, 0.66], [5, 0.5]] } ] }
```

- `name` and `hull` come from the player's most recent game. Players are sorted by final win rate, highest first.
- No games at all: `{ "mode": "active", "me": …, "games": [], "players": [] }`.
- Storage unavailable: `503 { "error": "Game history unavailable." }`. `/healthz` and gameplay are unaffected.

### 3. Client: the rivals chart

**Placement and loading**
- A new "Rivals" section on the home page, above the harbour log.
- Heading: "You and your rivals" (`mode: rivals`) or "Most active captains" (`mode: active`).
- Data is fetched with the saved name when the home page loads, and again after a game ends (the same moment `loadScores` refreshes the harbour log).

**Chart**
- Inline SVG, full width, about 200px tall, no external libraries.
- Y-axis 0–100% with light gridlines and labels at 0, 50 and 100%.
- X-axis: game index from oldest (left) to newest (right), with the first and last game dates labelled.
- One polyline per player in their hull colour. The viewer's line is thicker. Each line ends in a dot.

**Colour clashes:** in sorted player order, a player whose hull colour is already taken gets the first unused colour from the 8-colour palette.

**Legend**
- A list below the chart, one chip per player: colour dot, name, then "7 of 12 won · 58%".
- Tapping a chip toggles highlighting: that line at full strength, the others faded.
- The chips are real buttons, at least 44px tall, with `aria-pressed`.

**States**
- Loading: "Charting the rivalry…"
- 503 or network error: "The rivalry chart can't be read right now. You can still play."
- No games: "No voyages logged yet. Finish a game to start the chart."
- Players exist but none has 3 games: the legend is shown with the note "Lines appear from each captain's 3rd game."

**Accessibility:** the SVG has `role="img"` and a one-sentence `aria-label` summary (leader and their rate). The legend carries the full numbers as text. Every name is escaped.

## Error handling

| Failure | Behaviour |
|---|---|
| `games.json` missing | Start empty; the first save creates it |
| `games.json` corrupt or not an array | Log it, start empty; the next save replaces it |
| Data dir unreadable | `available = false`; `/api/rivals` returns 503; games still play and the harbour log works independently |
| Save fails | Log `[games] room XXXX result NOT saved`; play continues |
| Bad `name` query | Treated as no name (fallback mode); never an error |

## Testing

**Store unit tests (`games-store.test.js`)**
- An empty start.
- Records survive a restart.
- The 5,000-game cap.
- Malformed rows are discarded.
- Unavailable storage.
- The shared helper keeps the existing leaderboard tests green.

**Rivals maths (pure function, unit tested)**
- Name normalisation ("Anna" = " anna ").
- The rival choice, the 6-player cap and the tie-breaks.
- The fallback mode.
- The win-rate series.
- No points before the 3rd game.
- The 100-game window, with rates still counted from all history.
- Latest name and hull win.

**Server tests**
- A finished game is recorded once, with players, wins and hulls; spectators are excluded.
- `/api/rivals` returns the expected shape.
- 503 when storage is unavailable, while games still finish.

**Browser checks**
- The chart in light and dark mode at 320px and 390px.
- Legend highlighting.
- The empty, under-3-games and unavailable states.

## Scope boundaries

Not included:
- Accounts or a stronger identity than names.
- Back-filling past games.
- Within-game round-by-round charts.
- Tooltips or zooming on the chart.
- Changes to the harbour log, auction rules or the victory show.
- Pagination beyond the newest 100 games in the chart window.
- Running more than one machine (still one Fly machine and one volume).
