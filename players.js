// Shared player rules: ship hull colours and the name key that matches captains across games.
const HULLS = ['navy', 'coral', 'mango', 'hibiscus', 'palm', 'turquoise', 'purple', 'charcoal'];
const hullOf = h => HULLS.includes(h) ? h : 'navy';
const NAME_MAX = 20;
// "  Anna   Bell " and "anna bell" are the same captain.
const nameKey = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

module.exports = { HULLS, hullOf, nameKey, NAME_MAX };
