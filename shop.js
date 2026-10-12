// The ship shop: what can be bought, what a game pays, and which items are on sale this game. Purely visual items.
const CATALOG = {
  bomb: { kind: 'sabotage', name: 'Bomb', icon: '💣', price: 12 },
  kraken: { kind: 'sabotage', name: 'Kraken', icon: '🐙', price: 15 },
  cloud: { kind: 'sabotage', name: 'Rain cloud', icon: '🌧️', price: 8 },
  shark: { kind: 'sabotage', name: 'Shark', icon: '🦈', price: 6 },
  gulls: { kind: 'sabotage', name: 'Seagull raid', icon: '🐦', price: 10 },
  hose: { kind: 'defence', name: 'Fire hose', icon: '🧯', price: 6, blocks: 'bomb' },
  umbrella: { kind: 'defence', name: 'Umbrella', icon: '☂️', price: 4, blocks: 'cloud' },
  bubble: { kind: 'defence', name: 'Bubble shield', icon: '🫧', price: 10, blocks: '*' },
  gold: { kind: 'bling', name: 'Golden hull', icon: '✨', price: 120 },
  rainbow: { kind: 'bling', name: 'Rainbow smoke', icon: '🌈', price: 60 },
  disco: { kind: 'bling', name: 'Disco lights', icon: '🪩', price: 80 },
  parrot: { kind: 'bling', name: 'Parrot', icon: '🦜', price: 40 },
  bouquet: { kind: 'gift', name: 'Bouquet of roses', icon: '💐', price: 8 },
  lei: { kind: 'gift', name: 'Hibiscus garland', icon: '🌺', price: 5 },
  bottle: { kind: 'gift', name: 'Message in a bottle', icon: '💌', price: 3 },
  cake: { kind: 'gift', name: 'Cake', icon: '🍰', price: 12 },
  teddy: { kind: 'gift', name: 'Teddy bear', icon: '🧸', price: 10 },
  giftbox: { kind: 'gift', name: 'Gift box', icon: '🎁', price: 15 },
  fireworks: { kind: 'gift', name: 'Fireworks', icon: '🎆', price: 20 },
  diamond: { kind: 'gift', name: 'Diamond', icon: '💎', price: 50 },
};
const EMOTES = ['honk', 'ha', 'oops', 'ouch'];
const MARKET_SIZES = { sabotage: 3, defence: 2, gift: 4, bling: 2 };

// Today's market: a random pick per kind (partial Fisher-Yates with the given random, so tests can pin it).
function rollMarket(random) {
  const out = [];
  for (const [kind, n] of Object.entries(MARKET_SIZES)) {
    const pool = Object.keys(CATALOG).filter(k => CATALOG[k].kind === kind);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      out.push(pool[i]);
    }
  }
  return out;
}

const earnings = ({ score, won, torpedo }) => Math.floor(Math.max(0, score) / 10) + (won ? 10 : 0) + (torpedo ? 3 : 0);

// The defence a target's stock spends on this sabotage: the exact counter first, then a bubble shield.
function blockerFor(kind, stock) {
  const exact = Object.keys(CATALOG).find(k => CATALOG[k].blocks === kind);
  if (exact && stock[exact] > 0) return exact;
  return stock.bubble > 0 ? 'bubble' : null;
}

module.exports = { CATALOG, EMOTES, MARKET_SIZES, rollMarket, earnings, blockerFor };
