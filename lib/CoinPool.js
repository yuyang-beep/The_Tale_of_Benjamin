// Total pool per player: 2×10 + 4×5 + 10×1 (shared across all 5 personal rounds)
const INITIAL = { 10: 2, 5: 4, 1: 10 };
const DENOMS = [10, 5, 1];
const MAXCOUNTS = { 10: 2, 5: 4, 1: 10 }; // caps per denomination per round

class CoinPool {
  constructor() {
    // rounds[i]: coins allocated to personal round i (0-based)
    this.rounds = Array.from({ length: 5 }, () => ({ 10: 0, 5: 0, 1: 0 }));
  }

  // Dynamically compute remaining = INITIAL - sum of all rounds
  get remaining() {
    const rem = { 10: INITIAL[10], 5: INITIAL[5], 1: INITIAL[1] };
    for (const r of this.rounds) {
      for (const d of DENOMS) rem[d] -= r[d];
    }
    return rem;
  }

  get remainingTotal() {
    const rem = this.remaining;
    return DENOMS.reduce((s, d) => s + d * rem[d], 0);
  }

  // Replace the full allocation for a round slot.
  // Validates against current remaining (after temporarily zeroing this round).
  // Returns error string or null on success.
  setRound(roundIdx, investObj) {
    const old = this.rounds[roundIdx];
    const rem = this.remaining;
    for (const d of DENOMS) rem[d] += old[d]; // add back what this round currently holds

    const newAlloc = {};
    for (const d of DENOMS) {
      const want = investObj[d] ?? 0;
      if (!Number.isInteger(want) || want < 0) return `${d}金币数量无效`;
      if (want > MAXCOUNTS[d]) return `${d}金币超过上限（最多 ${MAXCOUNTS[d]} 枚）`;
      if (want > rem[d]) return `${d}金币不足（剩余 ${rem[d]} 枚，需要 ${want} 枚）`;
      newAlloc[d] = want;
    }
    this.rounds[roundIdx] = newAlloc;
    return null;
  }

  // ±1 adjustment of one denomination in a round.
  // Returns error string or null on success.
  adjust(roundIdx, denom, type) {
    denom = parseInt(denom);
    if (!DENOMS.includes(denom)) return '无效面额';
    const rem = this.remaining;

    if (type === 'add') {
      if (rem[denom] <= 0) return `无剩余 ${denom} 金币可添加`;
      if ((this.rounds[roundIdx][denom] ?? 0) >= MAXCOUNTS[denom])
        return `该轮 ${denom} 金币已达上限（${MAXCOUNTS[denom]} 枚）`;
      this.rounds[roundIdx][denom]++;
    } else if (type === 'remove') {
      if ((this.rounds[roundIdx][denom] ?? 0) <= 0)
        return `该轮无 ${denom} 金币可移除`;
      this.rounds[roundIdx][denom]--;
    } else {
      return '无效操作类型';
    }
    return null;
  }

  roundTotal(idx) {
    return DENOMS.reduce((s, d) => s + d * (this.rounds[idx][d] ?? 0), 0);
  }

  snapshot() {
    return {
      remaining: this.remaining,
      remainingTotal: this.remainingTotal,
      rounds: this.rounds.map(r => ({ ...r })),
      roundTotals: this.rounds.map((_, i) => this.roundTotal(i)),
    };
  }
}

module.exports = CoinPool;
