# Puerto Banana

Online bluff-and-auction game for 2-6 players, each on their own phone. Zero dependencies, Node 20+.

## Run locally
    node server.js      # http://localhost:8080
    node test.js        # rules engine tests

Same Wi-Fi: friends open http://<your-LAN-IP>:8080
Anywhere:   npx cloudflared tunnel --url http://localhost:8080   (or: ngrok http 8080)

## Deploy to Fly
    fly launch --no-deploy   # keep fly.toml, pick a unique app name
    fly deploy --ha=false    # ONE machine: game state lives in memory

Rooms live in memory, so a restart or Fly stopping an idle machine wipes them.
