// Shared player rules: ship hull colours and the name key that matches captains across games.
const HULLS = ['navy', 'coral', 'mango', 'hibiscus', 'palm', 'turquoise', 'purple', 'charcoal'];
const hullOf = h => HULLS.includes(h) ? h : 'navy';
const NAME_MAX = 20;
// Ship flags: a country/region code from the flag-icons set (e.g. "se", "gb-sct") or a hand-drawn
// easter egg. Anything else is '' (the default pennant). Codes only ever reach a CDN image path.
const FLAG_EGGS = ['pirate', 'banana', 'rainbow', 'chequered', 'white'];
const flagOf = f => FLAG_EGGS.includes(f) || /^[a-z]{2}(-[a-z]{2,4})?$/.test(f) ? f : '';
// "  Anna   Bell " and "anna bell" are the same captain.
const nameKey = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

module.exports = { HULLS, hullOf, nameKey, NAME_MAX, FLAG_EGGS, flagOf };
