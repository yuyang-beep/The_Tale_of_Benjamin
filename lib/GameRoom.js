const CoinPool = require('./CoinPool');
const { settleRound, guessBonus, benjaminRound } = require('./Scoring');

class Player {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.isBenjamin = false;
    this.pool = new CoinPool();
    this.totalScore = 0;
    this.roundScores = [];       // points earned each game round
    this.bonusScore = 0;
    // Action sub-phase flags
    this.hasAdjusted = false;   // submitted previous-round adjustment (or pass)
    this.hasInvested = false;   // submitted current-round coin allocation
    this.hasActed = false;      // true once hasInvested is true
    this.hasGuessed = false;
    this.guessedBenjaminCorrectly = false;
    this.pendingGuess = null;   // benjamin's stored ranking guess
    this.lastAdjust = null;     // { type, denom } from most recent submitAdjust
    this.connected = true;
  }
}

class GameRoom {
  constructor(roomId) {
    this.id = roomId;
    this.players = new Map(); // id → Player
    this.phase = 'waiting';
    this.gameRound = 0;       // 1-5 during game
    this.actionSubPhase = null; // 'adjust' | 'invest' | null
    this.hostId = null;
    this.guessesDone = new Set();
    this.guessSubPhase = null;  // 'normal' | 'benjamin' during guess phase
  }

  addPlayer(id, name) {
    if (this.phase !== 'waiting') return { error: 'game already started' };
    if (this.players.size >= 8) return { error: 'room full' };
    const p = new Player(id, name);
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    return { ok: true };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'waiting') {
      this.players.delete(id);
      if (this.hostId === id) {
        this.hostId = this.players.keys().next().value ?? null;
      }
    } else {
      p.connected = false;
      if (this.hostId === id) {
        const next = [...this.players.values()].find(q => q.connected);
        this.hostId = next?.id ?? null;
      }
    }
  }

  reconnectPlayer(newSocketId, name) {
    const entry = [...this.players.entries()].find(([, p]) => !p.connected && p.name === name);
    if (!entry) return { error: 'no disconnected player found' };
    const [oldId, p] = entry;
    this.players.delete(oldId);
    p.id = newSocketId;
    p.connected = true;
    this.players.set(newSocketId, p);
    if (!this.hostId) this.hostId = newSocketId;
    return { ok: true };
  }

  get allDisconnected() {
    return [...this.players.values()].every(p => !p.connected);
  }

  startGame() {
    if (this.players.size < 2) return { error: 'need at least 2 players' };
    const ids = [...this.players.keys()];
    const benjIdx = Math.floor(Math.random() * ids.length);
    ids.forEach((id, i) => {
      this.players.get(id).isBenjamin = (i === benjIdx);
    });
    this.gameRound = 1;
    this.phase = 'free';
    return { ok: true };
  }

  // ── Action phase ───────────────────────────────────────────────────────────

  beginAction() {
    this.phase = 'action';
    // Round 1 has no previous round to adjust; go straight to invest
    this.actionSubPhase = this.gameRound === 1 ? 'invest' : 'adjust';
    this.players.forEach(p => {
      p.hasAdjusted = this.gameRound === 1; // pre-mark as adjusted when skipping
      p.hasInvested = false;
      p.hasActed = false;
    });
  }

  // Sub-phase 1: player adjusts their previous personal round (±1) or passes.
  // action: { type: 'add'|'remove'|'pass', denom?: number }
  submitAdjust(playerId, action) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'player not found' };
    if (this.phase !== 'action') return { error: 'not action phase' };
    if (this.actionSubPhase !== 'adjust') return { error: 'not adjust sub-phase' };
    if (p.hasAdjusted) return { error: 'already adjusted' };

    if (action.type !== 'pass') {
      const gr = this.gameRound;
      const personalIdx = p.isBenjamin ? (5 - gr) : (gr - 1);
      const prevIdx = p.isBenjamin ? personalIdx + 1 : personalIdx - 1;

      if (prevIdx >= 0 && prevIdx < 5) {
        const err = p.pool.adjust(prevIdx, action.denom, action.type);
        if (err) return { error: err };
      }
    }

    p.lastAdjust = action;
    p.hasAdjusted = true;
    return { ok: true };
  }

  allAdjusted() {
    return [...this.players.values()].every(p => p.hasAdjusted || !p.connected);
  }

  beginInvest() {
    this.actionSubPhase = 'invest';
  }

  // Sub-phase 2: player allocates coins for their current personal round.
  // action: { investObj: { 10: n, 5: n, 1: n } }
  submitInvest(playerId, action) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'player not found' };
    if (this.phase !== 'action') return { error: 'not action phase' };
    if (this.actionSubPhase !== 'invest') return { error: 'not invest sub-phase' };
    if (p.hasInvested) return { error: 'already invested' };

    const gr = this.gameRound;
    const personalIdx = p.isBenjamin ? (5 - gr) : (gr - 1);

    const err = p.pool.setRound(personalIdx, action.investObj ?? {});
    if (err) return { error: err };

    p.hasInvested = true;
    p.hasActed = true;
    return { ok: true };
  }

  allActed() {
    return [...this.players.values()].every(p => p.hasInvested || !p.connected);
  }

  // ── Guess phase ────────────────────────────────────────────────────────────

  beginGuess() {
    if (this.gameRound > 3) { this.beginSettlement(); return; }
    this.phase = 'guess';
    this.guessSubPhase = 'normal';
    this.guessesDone.clear();
    this.players.forEach(p => {
      p.hasGuessed = false;
      // Auto-complete players who already correctly identified Benjamin
      if (!p.isBenjamin && p.guessedBenjaminCorrectly) {
        p.hasGuessed = true;
        this.guessesDone.add(p.id);
      }
    });
    // If all normals already done (all guessed correctly in prior rounds), skip to benjamin
    if (this.allNormalsGuessed()) this.guessSubPhase = 'benjamin';
  }

  // Normal players must all submit before Benjamin can submit (guessSubPhase enforces order).
  submitGuess(playerId, guess) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'player not found' };
    if (this.phase !== 'guess') return { error: 'not guess phase' };
    if (p.hasGuessed) return { error: 'already guessed' };

    const n = this.players.size;
    const gr = this.gameRound;

    if (!p.isBenjamin) {
      if (this.guessSubPhase !== 'normal') return { error: '不是普通玩家猜测阶段' };
      const correct = guess.suspectId === this._benjaminId();
      if (correct) {
        p.guessedBenjaminCorrectly = true;
        p.bonusScore += guessBonus('normal', true, gr, n);
      }
    } else {
      if (this.guessSubPhase !== 'benjamin') return { error: '请等待其他玩家完成猜测' };
      p.pendingGuess = guess.ranking;
    }

    p.hasGuessed = true;
    this.guessesDone.add(playerId);

    // After a normal submits, check if all normals done → unlock Benjamin sub-phase
    if (!p.isBenjamin && this.allNormalsGuessed()) {
      this.guessSubPhase = 'benjamin';
    }

    return { ok: true };
  }

  allNormalsGuessed() {
    return [...this.players.values()]
      .filter(p => !p.isBenjamin && p.connected)
      .every(p => p.hasGuessed);
  }

  allGuessed() {
    return [...this.players.values()].every(p => p.hasGuessed || !p.connected);
  }

  // ── Settlement ─────────────────────────────────────────────────────────────

  beginSettlement() {
    this.phase = 'settlement';
    const gr = this.gameRound;

    // Step 1: Sync totalScore (post-guess, pre-coin-settlement) so Benjamin's
    //         ranking prediction can be evaluated against the right order.
    this.players.forEach(p => {
      p.totalScore = p.roundScores.reduce((a, b) => a + b, 0) + p.bonusScore;
    });

    // Step 2: Resolve Benjamin's pending ranking guess
    const benjamin = [...this.players.values()].find(p => p.isBenjamin);
    if (benjamin?.pendingGuess) {
      const actualRanking = this._currentRanking().filter(id => id !== benjamin.id);
      let correct = 0;
      benjamin.pendingGuess.forEach((id, idx) => {
        if (actualRanking[idx] === id) correct++;
      });
      benjamin.bonusScore += correct;
      benjamin.pendingGuess = null;
    }

    // Step 3: Build roundCoins from pool for the scoring module
    const playerData = [...this.players.values()].map(p => ({
      id: p.id,
      isBenjamin: p.isBenjamin,
      roundCoins: p.pool.rounds.map((_, i) => p.pool.roundTotal(i)),
    }));
    const roundResult = settleRound(gr, playerData);

    // Step 4: Apply coin scores
    this.players.forEach(p => {
      const pts = roundResult[p.id]?.roundPoints ?? 0;
      p.roundScores.push(pts);
      p.totalScore = p.roundScores.reduce((a, b) => a + b, 0) + p.bonusScore;
    });
  }

  advanceRound() {
    if (this.gameRound >= 5) {
      this.phase = 'ended';
      return;
    }
    this.gameRound++;
    this.phase = 'free';
    this.actionSubPhase = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _currentRanking() {
    return [...this.players.values()]
      .sort((a, b) => b.totalScore - a.totalScore)
      .map(p => p.id);
  }

  _benjaminId() {
    return [...this.players.values()].find(p => p.isBenjamin)?.id;
  }

  // Public state for a specific player (hides others' sensitive info)
  publicState(viewerId) {
    const viewer = this.players.get(viewerId);
    const n = this.players.size;
    const gr = this.gameRound;

    // After everyone adjusts, reveal all scores so players can make
    // informed investment decisions (round 3+ only; round 2 stays hidden).
    const inInvest = this.phase === 'action' && this.actionSubPhase === 'invest';
    const showOthersScore =
      (inInvest && gr >= 3) ||
      (gr >= 3 && this.phase === 'settlement') ||
      this.phase === 'ended';

    const playersPublic = [...this.players.values()].map(p => {
      const isViewer = p.id === viewerId;
      return {
        id: p.id,
        name: p.name,
        isHost: p.id === this.hostId,
        connected: p.connected,
        isBenjamin: (isViewer || this.phase === 'ended') ? p.isBenjamin : undefined,
        totalScore: (isViewer || showOthersScore) ? p.totalScore : undefined,
        roundScores: (isViewer || this.phase === 'ended') ? p.roundScores : undefined,
        bonusScore: (isViewer || this.phase === 'ended') ? p.bonusScore : undefined,
        pool: (isViewer || this.phase === 'ended') ? p.pool.snapshot() : undefined,
        hasAdjusted: p.hasAdjusted,
        hasActed: p.hasActed,
        hasGuessed: p.hasGuessed,
        guessedBenjaminCorrectly: isViewer ? p.guessedBenjaminCorrectly : undefined,
      };
    });

    // Leaderboard: top 3 shown at settlement (round 3+) and during invest reveal (round 3+)
    let leaderboard = null;
    if (gr >= 3 && this.phase === 'settlement') {
      leaderboard = this._currentRanking()
        .slice(0, 3)
        .map(id => {
          const p = this.players.get(id);
          return { name: p.name, totalScore: p.totalScore };
        });
    }

    // ── Viewer's own adjust summary (invest sub-phase, round 2+) ───────────────
    let myAdjust = null;
    if (inInvest && gr >= 2 && viewer) {
      const personalIdx = viewer.isBenjamin ? (5 - gr) : (gr - 1);
      const prevIdx = viewer.isBenjamin ? personalIdx + 1 : personalIdx - 1;
      const prevRoundAfter = (prevIdx >= 0 && prevIdx < 5)
        ? { ...viewer.pool.rounds[prevIdx] }
        : null;
      myAdjust = {
        type: viewer.lastAdjust?.type ?? 'pass',
        denom: viewer.lastAdjust?.denom ?? null,
        prevRoundAfter,
        myTotalScore: viewer.totalScore,
      };
    }

    // ── All-player standings (invest sub-phase, round 3+ only) ─────────────────
    let adjustReveal = null;
    if (inInvest && gr >= 3) {
      adjustReveal = [...this.players.values()]
        .sort((a, b) => b.totalScore - a.totalScore)
        .map(p => ({ name: p.name, totalScore: p.totalScore }));
    }

    return {
      roomId: this.id,
      phase: this.phase,
      actionSubPhase: this.actionSubPhase,
      guessSubPhase: this.guessSubPhase,
      gameRound: gr,
      playerCount: n,
      players: playersPublic,
      leaderboard,
      myAdjust,       // viewer's own adjust result + totalScore (round 2+, invest)
      adjustReveal,   // all players sorted by score (round 3+, invest)
      isBenjamin: viewer?.isBenjamin,
      benjaminRound: viewer?.isBenjamin ? benjaminRound(gr) : undefined,
    };
  }
}

module.exports = GameRoom;
