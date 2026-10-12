# Puerto Banana: Credits and the Ship Shop

**Date:** 2026-10-12
**Status:** Design approved in conversation (sections 1–5); awaiting written-spec review
**Project:** Puerto Banana, a zero-dependency multiplayer bluff-and-auction game

## Intent and success criteria

Give players something fun to do while waiting for others to bid, and a reason to keep playing. Each finished game earns credits (🪙). Players spend them on visible, cosmetic items that everyone in the room sees:
- sabotage thrown at rivals;
- defence against sabotage;
- permanent bling for their own ship;
- emotes.

Success means:
- Items never change bids, bananas, payments or who wins. The auction stays exactly as fair as today.
- Everyone in a room sees the same effects at the same time, on every ship drawing of the affected player.
- Credits cannot be faked from the browser. The server alone awards, checks and spends them.
- It stays fun, not spammy: per-round and per-ship limits, and emote cooldowns.
- A broken or missing wallet store closes the shop but never blocks or breaks a game.

## Decisions made in conversation

| Question | Decision |
|---|---|
| What items can do | Purely visual; no effect on the auction |
| Whose wallet | By device: the existing hidden per-browser token; a new device or cleared browser starts at 0 |
| First version contents | Sabotage, Defence, Bling and Emotes |
| Architecture | Approach A: server-side wallets and effects, with limits |

## Design

### 1. Credits and wallets

**Earning.** Credits are awarded when a game ends, inside the existing once-per-game guard (`recordGame`, `room.scoresRecorded`), to every player in `room.order`. Spectators get nothing.
- `floor(finalBananas / 10)`
- +10 if the player is among the winners (each tied winner gets it)
- +3 to every player when the game was a torpedo game (`room.torpedo`)

**Storage.** A new `wallets.json` in `DATA_DIR` on the Fly volume, managed through `json-file-store.js`.
- Each wallet: `{ id, credits, stock: { [item]: n }, owned: [bling], worn: [bling], emotedAt }`.
- `id` is a SHA-256 hash of the player token. Raw tokens are never written to this file.
- Malformed rows are logged and dropped, as in the other stores.

**Visibility.**
- Each player's own balance is in their room view as `wallet: { credits, stock, owned, worn }`. Other players' balances are never sent.
- The end screen shows what each player earned. Captain Bongo announces "+19 🪙" for you.
- Your balance shows as 🪙 on your ship card in the game.

**Unavailable storage.** Shop actions answer `400 { error: 'The shop is closed right now.' }`. Games, scores and the harbour log carry on, and earnings are skipped with a log line.

### 2. Item catalogue

This lives in one shared module, `shop.js`. The server uses it for prices and rules; the client gets the same list from `GET /api/shop`.

**Sabotage.** One use, aimed at a rival during a round, and lasts until that round resolves.

| Item | Price | Effect |
|---|---|---|
| bomb 💣 | 12 | fire and black smoke on their deck |
| kraken 🐙 | 15 | tentacles rise and rock their hull |
| cloud 🌧️ | 8 | a little storm over their ship |
| shark 🦈 | 6 | a fin circles their ship |
| gulls 🐦 | 10 | gulls fly off with bananas from their pile (visual only) |

**Defence.** One use, kept in your stock until it's triggered.

| Item | Price | Blocks |
|---|---|---|
| hose 🧯 | 6 | bomb |
| umbrella ☂️ | 4 | cloud |
| bubble 🫧 | 10 | the next sabotage of any kind |

**Bling.** Bought once, owned forever, worn on or off.

| Item | Price |
|---|---|
| gold ✨ (golden hull shimmer) | 120 |
| rainbow 🌈 (rainbow funnel smoke) | 60 |
| disco 🪩 (disco deck lights) | 80 |
| parrot 🦜 (parrot on the mast) | 40 |

**Emotes.** Free, with a 10-second cooldown per player: `honk` 📯, `ha` "Ha!", `oops` "Oops", `ouch` "Ouch".

### 3. Server flow

New actions on `POST /api`, authenticated by player token like bids:

**`buy { item, target? }`**
- **Sabotage:**
  - Only when `room.status === 'playing'`, the buyer is in `room.order`, and `target` is another player in `room.order`.
  - Limits: the buyer has not already sabotaged this round, and the target has fewer than 2 active sabotages.
  - The buyer must have enough credits; they are deducted whether or not the attack is then blocked.
  - **Blocked:** if the target holds a matching defence (the exact one first, then bubble), one is used up and an effect `{ kind, from, target, round, blocked: defenceItem }` is added.
  - **Not blocked:** an effect `{ kind, from, target, round }` is added.
- **Defence:** adds one to the buyer's `stock`. Allowed in any room status.
- **Bling:** adds it to `owned` if not already owned, and also wears it.
- **Errors**, each a `400` with a clear message:
  - "Not enough 🪙: Kraken costs 15."
  - "You've already sabotaged this round."
  - "Bo's ship can't take any more right now."
  - "Pick a rival's ship."
  - "Unknown item."
  - "The shop is closed right now."

**`wear { item, on }`** toggles owned bling. Worn bling is copied onto the player in the room, as `player.bling`, so it travels in the view like `hull` and `flag`.

**`emote { kind }`**
- Refused within 10 s of the player's last emote ("Wait a moment before the next one.").
- Adds a short-lived effect `{ kind, from, at }`, and `view()` drops emote effects older than 4 s.

**Room state.**
- `room.effects` holds the live effects. It's saved with the room in `rooms.json`, so effects survive restarts.
- `view()` includes `effects` (with `from` and `target` as player ids), each player's `bling`, and the viewer's own `wallet`.
- Blocked effects carry an `at` timestamp and, like emotes, `view()` drops them after 4 s, which is long enough for the counter-animation to play once.
- When a round resolves, all of its sabotage effects (blocked or not) are removed.
- `newGame`, `lobby` and `rematch` clear `room.effects`.

**Credits at game end** use the same once-only guard as scores and history.

### 4. Client

**Shop sheet**
- A 🪙 **Shop** button sits next to "Lock in bid" and also shows on the lobby and end screens.
- The sheet has four tabs: Sabotage, Defence, Bling and Emotes. Each item shows its icon, name, price and a small preview; unaffordable items are greyed out.
- Sabotage tabs only during a round. Defence, Bling and Emotes are always available.
- Picking a sabotage switches to target mode: the sheet closes, rivals' rows in the player list glow, a tap on one fires the attack, and a "Cancel" chip backs out.

**Effects** are drawn by the ship SVG (`shipBody`), so they appear on every drawing of the target ship: the big "Your ship" scene and the player-list tiles.

| Effect | How it looks |
|---|---|
| bomb | flickering flames and black smoke replace the funnel smoke |
| kraken | two or three tentacles rise beside the hull and the ship rocks harder |
| cloud | a small grey cloud with rain over the ship |
| shark | a fin circling in the water |
| gulls | three gulls fly off, each carrying a banana |

When an attack is blocked, the counter-animation plays once instead: a water spray (hose), an umbrella popping open (umbrella), or a bubble bursting (bubble).

**Bling** is drawn the same way: a gold hull gradient with a shimmer, rainbow-tinted smoke puffs, coloured lights pulsing along the deck, or a parrot on the mast.

**Captain Bongo toasts.** A small bubble near the top shows for about 3 s on everyone's screen, for example:
- "🐙 Anna unleashed a Kraken on Bo!"
- "🧯 Bo hosed down Anna's bomb!"

**Emotes** appear as a bubble over the sender's ship in the player list and on their own big ship.

**Reduced motion:** effects show as still badges on the ship (🔥 🐙 🌧️ 🦈 🐦) and toasts still appear.

**Everything is escaped**, and item and effect names only come from the shared catalogue.

### 5. Testing

**Unit tests for `shop.js`**
- Catalogue prices, kinds and matching defences.
- The earning formula.

**Server tests**
- Credits are paid once per game with the right amounts, including tied winners and torpedo games, and none to spectators.
- Buying with too few credits is refused, and the balance doesn't change.
- Sabotage limits: one per buyer per round, at most two per target, never yourself or a spectator, only while playing.
- A matching defence blocks and is used up; a bubble blocks anything; credits are still spent.
- Effects clear when the round resolves and on rematch, lobby or new game.
- Bling can be bought, worn and unworn, and shows on the player in every view.
- The emote cooldown holds, and emotes expire from the view after 4 s.
- The viewer's own wallet is in the view; other players' wallets are never exposed.
- Wallets and effects survive a server restart.
- An unreadable `wallets.json` closes the shop but games still finish and record scores.

**Browser checks** at 320px and 390px, light and dark:
- every sabotage, block and bling item;
- the shop sheet and target mode;
- toasts and emotes;
- a full 3-player game using items.

## Scope boundaries

Not included:
- Items that affect bids, bananas or outcomes.
- Accounts, wallet recovery codes or moving a wallet between devices.
- Trading or gifting credits.
- Real-money purchases of any kind.
- A leaderboard of credits.
- Sound effects.
- Multiple machines (still one Fly machine and one volume).
