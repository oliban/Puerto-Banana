// Shared player rules: ship hull colours and the name key that matches captains across games.
const HULLS = ['navy', 'coral', 'mango', 'hibiscus', 'palm', 'turquoise', 'purple', 'charcoal'];
const hullOf = h => HULLS.includes(h) ? h : 'navy';
const CABINS = ['white', 'sand', 'sunshine', 'mint', 'sky', 'pink'];
const cabinOf = c => CABINS.includes(c) ? c : 'white';
const NAME_MAX = 20;
// Ship flags: a country/region code from the flag-icons set (e.g. "se", "gb-sct") or a hand-drawn
// easter egg. Anything else is '' (the default pennant). Codes only ever reach a CDN image path.
const FLAG_EGGS = ['pirate', 'banana', 'rainbow', 'chequered', 'white', 'bongo', 'pineapple', 'parrot', 'kraken', 'pizza', 'unicorn', 'duck', 'arcade'];
// Swedish provinces (landskap), served from assets/flags/se/<slug>.svg as flag code "ls-<slug>".
const LANDSKAP = ['blekinge', 'bohuslan', 'dalarna', 'dalsland', 'gotland', 'gastrikland', 'halland', 'halsingland', 'harjedalen',
  'jamtland', 'lappland', 'medelpad', 'norrbotten', 'narke', 'skane', 'smaland', 'sodermanland', 'uppland', 'vasterbotten',
  'varmland', 'vastergotland', 'vastmanland', 'angermanland', 'oland', 'ostergotland'];
const flagOf = f => typeof f !== 'string' ? ''
  : f.startsWith('ls-') ? (LANDSKAP.includes(f.slice(3)) ? f : '')
  : FLAG_EGGS.includes(f) || /^[a-z]{2}(-[a-z]{2,4})?$/.test(f) ? f : '';
// "  Anna   Bell " and "anna bell" are the same captain.
const nameKey = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

module.exports = { HULLS, hullOf, CABINS, cabinOf, nameKey, NAME_MAX, FLAG_EGGS, LANDSKAP, flagOf };
