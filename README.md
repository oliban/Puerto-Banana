# Puerto Banana

Online bluff-and-auction game for 2-6 players, each on their own phone. Zero dependencies, Node 20+.

## Run locally
    DATA_DIR=./data node server.js   # http://localhost:8080, leaderboard saved in ./data
    npm test                         # rules engine, leaderboard store and HTTP tests

Same Wi-Fi: friends open http://<your-LAN-IP>:8080
Anywhere:   npx cloudflared tunnel --url http://localhost:8080   (or: ngrok http 8080)

## Deploy to Fly
Pushing to `main` deploys through GitHub Actions (`.github/workflows/fly.yml`), always as ONE machine (`--ha=false`).

What survives what:
- **Leaderboard** (top 20 winners): a JSON file on the Fly volume `pb_data`, mounted at `/data`.
  It survives restarts and deploys. The workflow creates the volume if it is missing.
- **Rooms and games in progress** live in memory, so a restart or Fly stopping an idle machine wipes them.

The volume belongs to the single machine and is not replicated. Don't scale beyond one machine:
rooms would split across machines and each machine would need its own volume.
