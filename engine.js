// Pure auction resolver. inv: {id: n}, bids: {id: n}, pot: n, order: [ids]
function resolveAuction(inv, bids, pot, order) {
  const out = { ...inv };
  const steps = [];
  const twoPlayer = order.length === 2;
  let cands = order.filter(id => id in bids);
  while (true) {
    if (cands.length === 0) { steps.push({ t: 'nobody' }); break; }
    if (cands.length === 1) {
      const w = cands[0];
      out[w] += pot;
      steps.push({ t: 'last', id: w, gain: pot });
      break;
    }
    const top = Math.max(...cands.map(id => bids[id]));
    const tops = cands.filter(id => bids[id] === top);
    if (tops.length > 1) {
      const share = Math.floor(pot / tops.length);
      tops.forEach(id => { out[id] += share; });
      steps.push({ t: 'tie', ids: tops, bid: top, share });
      break;
    }
    const w = tops[0];
    const rest = cands.filter(id => id !== w);
    const second = Math.max(...rest.map(id => bids[id]));
    const seconds = rest.filter(id => bids[id] === second);
    const premium = top - second;
    if (out[w] + pot < premium) {
      const lost = twoPlayer ? 0 : out[w];
      if (!twoPlayer) out[w] = 0;
      steps.push({ t: 'bust', id: w, bid: top, premium, lost, keeps: twoPlayer });
      cands = rest;
      continue;
    }
    out[w] += pot - premium;
    const share = Math.floor(premium / seconds.length);
    seconds.forEach(id => { out[id] += share; });
    steps.push({ t: 'win', id: w, bid: top, gain: pot, premium, to: seconds, second, share });
    break;
  }
  return { inv: out, steps };
}
if (typeof module !== 'undefined') module.exports = { resolveAuction };
