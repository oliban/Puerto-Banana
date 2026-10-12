const a = require('assert/strict');
const { CATALOG, EMOTES, MARKET_SIZES, rollMarket, earnings, blockerFor } = require('./shop');

const seq = vals => { let i = 0; return () => vals[i++ % vals.length]; };

const tests = {
  async 'catalogue has the agreed items and prices'() {
    const price = k => CATALOG[k].price;
    a.deepEqual([price('bomb'), price('kraken'), price('cloud'), price('shark'), price('gulls')], [12, 15, 8, 6, 10]);
    a.deepEqual([price('hose'), price('umbrella'), price('bubble')], [6, 4, 10]);
    a.deepEqual([price('gold'), price('rainbow'), price('disco'), price('parrot')], [120, 60, 80, 40]);
    a.deepEqual(['bouquet', 'lei', 'bottle', 'cake', 'teddy', 'giftbox', 'fireworks', 'diamond'].map(price), [8, 5, 3, 12, 10, 15, 20, 50]);
    a.deepEqual(EMOTES, ['honk', 'ha', 'oops', 'ouch']);
    for (const [k, it] of Object.entries(CATALOG)) {
      a.ok(['sabotage', 'defence', 'gift', 'bling'].includes(it.kind), k);
      a.ok(it.name && it.icon && Number.isInteger(it.price) && it.price > 0, k);
    }
  },
  async 'a market has the right number per kind, no repeats, and differs between rolls'() {
    const m = rollMarket(Math.random);
    for (const [kind, n] of Object.entries(MARKET_SIZES)) a.equal(m.filter(k => CATALOG[k].kind === kind).length, n, kind);
    a.equal(new Set(m).size, m.length);
    const rolls = new Set(Array.from({ length: 20 }, () => rollMarket(Math.random).join()));
    a.ok(rolls.size > 1, 'stock changes between games');
  },
  async 'a pinned random gives a pinned market'() {
    a.deepEqual(rollMarket(seq([0.1, 0.5, 0.9, 0.3])), rollMarket(seq([0.1, 0.5, 0.9, 0.3])));
  },
  async 'earnings: bananas / 10, +10 for winning, +3 in a torpedo game'() {
    a.equal(earnings({ score: 0, won: false, torpedo: false }), 0);
    a.equal(earnings({ score: 149, won: false, torpedo: false }), 14);
    a.equal(earnings({ score: 214, won: true, torpedo: false }), 31);
    a.equal(earnings({ score: 5, won: false, torpedo: true }), 3);
  },
  async 'blocking: exact defence first, then bubble, else nothing'() {
    a.equal(blockerFor('bomb', { hose: 1, bubble: 1 }), 'hose');
    a.equal(blockerFor('bomb', { bubble: 1 }), 'bubble');
    a.equal(blockerFor('cloud', { umbrella: 2 }), 'umbrella');
    a.equal(blockerFor('kraken', { hose: 1, umbrella: 1 }), null);
    a.equal(blockerFor('shark', {}), null);
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
