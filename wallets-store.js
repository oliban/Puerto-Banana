// Credits and shop items per device, keyed by a hash of the player token (raw tokens are never stored).
// Wallets live in memory so game actions can check and spend synchronously; saves happen in the background.
const crypto = require('crypto');
const { createJsonFileStore } = require('./json-file-store');
const { CATALOG } = require('./shop');

const FILE = 'wallets.json';
const idOf = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const empty = () => ({ credits: 0, stock: {}, owned: [], worn: [] });
const copy = w => ({ credits: w.credits, stock: { ...w.stock }, owned: [...w.owned], worn: [...w.worn] });

function clean(r) {
  if (!r || typeof r !== 'object' || !/^[a-f0-9]{64}$/.test(r.id) || !Number.isSafeInteger(r.credits) || r.credits < 0) return null;
  const known = (k, kind) => CATALOG[k] && CATALOG[k].kind === kind;
  const stock = {};
  for (const [k, n] of Object.entries(r.stock || {})) if (known(k, 'defence') && Number.isSafeInteger(n) && n > 0) stock[k] = n;
  const owned = (Array.isArray(r.owned) ? r.owned : []).filter(k => known(k, 'bling'));
  const worn = (Array.isArray(r.worn) ? r.worn : []).filter(k => owned.includes(k));
  return { id: r.id, credits: r.credits, stock, owned: [...new Set(owned)], worn: [...new Set(worn)] };
}

function createWalletsStore({ dataDir = process.env.DATA_DIR || '/data', logger = console } = {}) {
  const base = createJsonFileStore({ dataDir, file: FILE, label: 'wallets', clean, logger,
    unavailableMessage: 'Wallet storage is unavailable.' });
  const wallets = new Map();
  const ready = base.ready.then(() => { for (const r of base.rows()) wallets.set(r.id, copy(r)); });
  let timer = null;
  const flush = async () => {
    clearTimeout(timer); timer = null;
    await ready;
    if (!base.available) return;
    await base.update(() => [...wallets].map(([id, w]) => ({ id, ...copy(w) }))).catch(e => logger.error('[wallets] save failed:', e.message));
  };
  return {
    get available() { return base.available; },
    logger, ready, flush,
    get: token => copy(wallets.get(idOf(token)) || empty()),
    change(token, fn) {
      const id = idOf(token);
      const w = wallets.get(id) || empty();
      fn(w);
      wallets.set(id, w);
      if (!timer) timer = setTimeout(flush, 250);
      return copy(w);
    },
  };
}

module.exports = { createWalletsStore };
