// Returns benjamin's personal round number given a game round (1-5)
// Normal: R1→R2→R3→R4→R5
// Benjamin: R5→R4→R3→R2→R1
function benjaminRound(gameRound) {
  return 6 - gameRound;
}

// Rank players by value (desc). Ties share averaged scores.
// players: [{ id, value }], maxScore: n
// Returns { id → points }
function rankAndScore(players, maxScore) {
  const sorted = [...players].sort((a, b) => b.value - a.value);
  const points = {};
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    // find tie group
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    // positions i+1 … j (1-indexed), scores maxScore-i … maxScore-(j-1)
    const posScores = [];
    for (let k = i; k < j; k++) posScores.push(maxScore - k);
    const shared = posScores.reduce((a, b) => a + b, 0) / posScores.length;
    for (let k = i; k < j; k++) points[sorted[k].id] = shared;
    i = j;
  }
  return points;
}

// Settle one game round.
// gameRound: 1-5
// players: array of { id, isBenjamin, roundCoins: [r1,r2,r3,r4,r5] (indexed 0-4) }
// Returns { id → { roundPoints, cumulativeCoins, isFixed } }
function settleRound(gameRound, players) {
  const n = players.length;
  const double = gameRound >= 4;
  const maxScore = double ? n * 2 : n;

  if (gameRound <= 2) {
    // Benjamin fixed n (or 2n if doubled, but rounds 1-2 are never doubled)
    // Normal players ranked among themselves only
    const benjamin = players.find(p => p.isBenjamin);
    const normals = players.filter(p => !p.isBenjamin);

    const normalValues = normals.map(p => ({
      id: p.id,
      value: p.roundCoins[gameRound - 1],
    }));

    // Normal players score 1 to n-1 (not n, benjamin holds that slot)
    const normalPoints = rankAndScore(normalValues, n - 1);

    const result = {};
    normals.forEach(p => {
      result[p.id] = { roundPoints: normalPoints[p.id] ?? 0, isFixed: false };
    });
    result[benjamin.id] = { roundPoints: n, isFixed: true };
    return result;
  }

  if (gameRound === 3) {
    // All compete on current round's individual coin investment
    const values = players.map(p => ({
      id: p.id,
      value: p.roundCoins[gameRound - 1],
    }));
    const pts = rankAndScore(values, maxScore);
    const result = {};
    players.forEach(p => { result[p.id] = { roundPoints: pts[p.id] ?? 0, isFixed: false }; });
    return result;
  }

  // Rounds 4 and 5: rank by CUMULATIVE coin total
  // Normal player cumulative = sum of their rounds 1 to gameRound
  // Benjamin cumulative = sum of their rounds (6-gameRound) to 5
  //   gameRound=4 → benjamin rounds 2..5 = indices 1..4
  //   gameRound=5 → benjamin rounds 1..5 = indices 0..4
  const values = players.map(p => {
    let cumulative;
    if (p.isBenjamin) {
      const startIdx = 6 - gameRound - 1; // e.g. GR4 → idx 1 (round 2)
      cumulative = p.roundCoins.slice(startIdx).reduce((a, b) => a + b, 0);
    } else {
      cumulative = p.roundCoins.slice(0, gameRound).reduce((a, b) => a + b, 0);
    }
    return { id: p.id, value: cumulative };
  });

  const pts = rankAndScore(values, maxScore);
  const result = {};
  players.forEach(p => { result[p.id] = { roundPoints: pts[p.id] ?? 0, isFixed: false }; });
  return result;
}

// Add guess-phase bonus points
// guessResult: { guesserType: 'normal'|'benjamin', correct: bool, gameRound: 1-3, n }
function guessBonus(guesserType, correct, gameRound, n) {
  if (!correct) return 0;
  if (guesserType === 'normal') {
    // Correct Benjamin guess: round 1 = n, round 2 = n/2, round 3 = n/4
    return Math.floor(n / Math.pow(2, gameRound - 1));
  }
  // Benjamin guesses a ranking correctly: +1 per correct
  return 1;
}

module.exports = { settleRound, guessBonus, benjaminRound };
