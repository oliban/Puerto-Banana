const a = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { FLAG_EGGS, LANDSKAP, flagOf } = require('./players');

// assets/taunts.json: flag code ("pennant" for no flag) -> 3-5 taunts shown to a loser flying that flag.
const taunts = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'taunts.json'), 'utf8'));

const tests = {
  async 'every flag the picker offers has taunts'() {
    for (const k of ['pennant', ...FLAG_EGGS, ...LANDSKAP.map(s => 'ls-' + s)]) a.ok(taunts[k], `missing ${k}`);
    const countries = Object.keys(taunts).filter(k => k !== 'pennant' && !FLAG_EGGS.includes(k) && !k.startsWith('ls-'));
    a.ok(countries.length >= 250, `only ${countries.length} country and region flags`);
  },
  async 'every key is a flag code the game accepts'() {
    for (const k of Object.keys(taunts)) if (k !== 'pennant') a.equal(flagOf(k), k, `not a valid flag code: ${k}`);
  },
  async 'each flag has 3 to 5 distinct, readable taunts'() {
    for (const [k, list] of Object.entries(taunts)) {
      a.ok(Array.isArray(list) && list.length >= 3 && list.length <= 5, `${k} has ${list.length}`);
      a.equal(new Set(list).size, list.length, `${k} repeats a taunt`);
      for (const t of list) {
        a.equal(typeof t, 'string');
        a.ok(t.length >= 15 && t.length <= 140, `${k}: length ${t.length}: ${t}`);
        a.doesNotMatch(t, /[<>]/, `${k}: markup in taunt`);
      }
    }
  },
  async 'no taunt is copy-pasted between flags'() {
    const seen = new Map();
    for (const [k, list] of Object.entries(taunts)) for (const t of list) {
      a.ok(!seen.has(t), `"${t}" used by both ${seen.get(t)} and ${k}`);
      seen.set(t, k);
    }
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
