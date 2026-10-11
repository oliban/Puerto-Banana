# Puerto Banana: Banana Boat Design

**Date:** 2026-10-11  
**Status:** Design approved in conversation; awaiting written-spec review  
**Project:** Puerto Banana, a zero-dependency multiplayer bluff-and-auction game

## Intent and success criteria

Make the existing game feel like playing aboard a banana boat, with a polished mobile-first interface. Preserve the current game flow and rules. Remember each player’s display name between visits on their device. Add a shared highscore list that survives application restarts and deployments.

Success means:

- The interface has a clear banana-boat-at-sea visual identity and adapts cleanly to narrow phones, including safe-area insets and touch-friendly controls.
- The player name is restored on later visits using browser-local storage.
- Completed games record winner name(s), score, and completion time in durable server-side storage.
- A leaderboard is visible from the home screen, shared across players, and limited to the top 20 entries.
- Existing room, auction, and multiplayer behavior remains intact.

## Design

### Visual experience

Retheme the existing single-page client, retaining its zero-dependency HTML/CSS/JavaScript architecture. Use an ocean/deck palette with banana yellow as the action accent. Layer in subtle nautical and cargo-ship motifs without sacrificing contrast or readability. Establish a clear hierarchy for the brand, room status, auction pot, current player’s bananas, bid entry, and player standings. Make mobile the baseline: responsive spacing and typography, full-width primary actions, at least 44px touch targets, keyboard-visible focus, reduced-motion support, and safe-area-aware padding. Ensure the layout remains usable at 320px viewport width and respects light/dark system preference.

### Name memory

Continue storing the player’s chosen name in localStorage under the existing `pb_nick` key. Populate the name field on the home screen and carry the saved name into room creation or joining as today. Storage access remains guarded so the app works when browser storage is unavailable.

### Durable highscore storage

Keep the current one-machine Fly deployment model and use a Fly persistent volume mounted at `/data`; no database service or runtime package dependency is introduced. Store leaderboard entries in a JSON file under that mount. Read existing entries safely at server startup; serialize each completed-game append, write to a temporary file, and atomically rename it to avoid partially written state. If storage cannot be initialized or written, report an error in server logs and keep game play available; do not silently claim that a score was saved.

A new completed game contributes one entry per winner, with the display name captured from the completed room, their final banana count, and a server-generated completion timestamp. Tied winners each receive an entry at the same score/time. Sort by score descending and then completion time ascending; retain and return only the best 20 entries. A server-side `GET /api/highscores` endpoint returns a JSON array of public entries. No client-supplied score is accepted, and repeated requests must not add duplicate entries: record only on the transition into the completed state, exactly once per room game. Escape names in the client renderer.

The home screen displays the top 20 entries in a compact, readable leaderboard. Empty, loading, and unavailable states are explicit; failure to retrieve highscores must not prevent room creation or joining.

### Data and privacy

Leaderboard entries are public to visitors of the game and include the display name the player already chose, final banana score, and timestamp. Do not store session tokens or room codes in the leaderboard. Name persistence remains local to the player’s browser.

### Operations and compatibility

Provision and mount a Fly volume for `/data` through the repository’s deployment configuration and GitHub Actions setup as appropriate. The leaderboard’s durability depends on the single app machine and its attached volume; do not scale to multiple active instances or claim volume replication. Existing game rooms remain in-memory and keep their current restart behavior. The health endpoint should continue to work independently of leaderboard read availability.

### Verification

- Preserve and run the existing auction rules tests.
- Add server/API tests for empty leaderboard, public reads, score recording on game completion, ties, ranking/truncation, and no duplicate recording.
- Test persistence by restarting the server against the same data directory.
- Verify names are escaped in UI rendering and storage-disabled operation leaves gameplay available.
- Check the mobile layout at 320px and 390–400px widths, including touch target sizes and safe-area behavior.
- Confirm the deployment workflow provisions/mounts the intended volume and that the one-machine constraints are documented.

## Scope boundaries

This change does not alter auction rules, add accounts or cross-device identity, create a moderation system, scale the app to multiple machines, or turn the leaderboard into a general statistics service. It does not destroy or migrate the separately deployed `puerto-banana-fredrik` Fly app; that action was blocked by a safety control and requires separate handling.
