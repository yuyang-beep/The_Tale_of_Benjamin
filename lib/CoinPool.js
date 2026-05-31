// Each player starts with: 2×10 + 4×5 + 10×1 = 50 total value
const INITIAL = { 10: 2, 5: 4, 1: 10 };
const DENOMS = [10, 5, 1];

class CoinPool {
  constructor() {
    // unused[d] = coins of denomination d not yet invested
    // invested[d] = coins of denomination d currently invested this round
    this.unused = { ...INITIAL };
    this.invested = { 10: 0, 5: 0, 1: 0 };
  }

  get investedTotal() {
    return DENOMS.reduce((s, d) => s + d * this.invested[d], 0);
  }

  // Round 1: player freely sets their initial investment
  // Returns error string or null
  setInitial(investObj) {
    for (const d of DENOMS) {
      const want = investObj[d] ?? 0;
      if (want < 0 || want > INITIAL[d]) return `invalid amount for denomination ${d}`;
    }
    this.invested = { 10: investObj[10] ?? 0, 5: investObj[5] ?? 0, 1: investObj[1] ?? 0 };
    for (const d of DENOMS) this.unused[d] = INITIAL[d] - this.invested[d];
    return null;
  }

  // Round 2+: add one unused coin (by denomination) into invested
  addCoin(denom) {
    if (!DENOMS.includes(denom)) return 'invalid denomination';
    if (this.unused[denom] <= 0) return `no unused ${denom}-coin available`;
    this.unused[denom]--;
    this.invested[denom]++;
    return null;
  }

  // Round 2+: remove one invested coin (by denomination) back to unused
  removeCoin(denom) {
    if (!DENOMS.includes(denom)) return 'invalid denomination';
    if (this.invested[denom] <= 0) return `no invested ${denom}-coin to remove`;
    this.invested[denom]--;
    this.unused[denom]++;
    return null;
  }

  snapshot() {
    return {
      unused: { ...this.unused },
      invested: { ...this.invested },
      total: this.investedTotal,
    };
  }

  static initialSnapshot() {
    return { unused: { ...INITIAL }, invested: { 10: 0, 5: 0, 1: 0 }, total: 0 };
  }
}

module.exports = CoinPool;
