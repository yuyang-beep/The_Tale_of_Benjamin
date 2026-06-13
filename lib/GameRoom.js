const CoinPool = require('./CoinPool');
const { settleRound, guessBonus, benjaminRound } = require('./Scoring');

class Moderator {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.connected = true;
  }
}

class Player {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.isBenjamin = false;
    this.pool = new CoinPool();
    this.totalScore = 0;
    this.roundScores = [];
    this.bonusScore = 0;
    this.hasAdjusted = false;
    this.hasInvested = false;
    this.hasActed = false;
    this.hasGuessed = false;
    this.guessedBenjaminCorrectly = false;
    this.guessedCorrectThisRound = false;
    this.pendingGuess = null;
    this.lastAdjust = null;
    this.connected = true;
  }
}

class GameRoom {
  constructor(roomId) {
    this.id = roomId;
    this.players = new Map();
    this.moderator = null;
    this.phase = 'waiting';
    this.gameRound = 0;
    this.actionSubPhase = null;
    this.guessesDone = new Set();
    this.guessSubPhase = null;
    this.roundLog = [];
  }

  // ── Moderator ──────────────────────────────────────────────────────────────

  addModerator(id, name) {
    if (this.moderator) return { error: 'moderator already exists' };
    if (this.phase !== 'waiting') return { error: 'game already started' };
    this.moderator = new Moderator(id, name);
    return { ok: true };
  }

  reconnectModerator(newSocketId, name) {
    if (!this.moderator) return { error: 'no moderator in this room' };
    if (this.moderator.connected) return { error: 'moderator already connected' };
    if (this.moderator.name !== name) return { error: 'name mismatch' };
    this.moderator.id = newSocketId;
    this.moderator.connected = true;
    return { ok: true };
  }

  get isPaused() {
    return !!(this.moderator && !this.moderator.connected);
  }

  // ── Players ────────────────────────────────────────────────────────────────

  addPlayer(id, name) {
    if (this.phase !== 'waiting') return { error: 'game already started' };
    if (this.players.size >= 12) return { error: 'room full' };
    const p = new Player(id, name);
    this.players.set(id, p);
    return { ok: true };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'waiting') {
      this.players.delete(id);
    } else {
      p.connected = false;
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
    return { ok: true };
  }

  get allDisconnected() {
    const modDown = !this.moderator || !this.moderator.connected;
    return modDown && [...this.players.values()].every(p => !p.connected);
  }

  // ── Game control ───────────────────────────────────────────────────────────

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
    this.actionSubPhase = this.gameRound === 1 ? 'invest' : 'adjust';
    this.players.forEach(p => {
      p.hasAdjusted = this.gameRound === 1;
      p.hasInvested = false;
      p.hasActed = false;
      p.guessedCorrectThisRound = false;
    });
  }

  submitAdjust(playerId, action) {
    if (this.isPaused) return { error: 'game paused' };
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

  submitInvest(playerId, action) {
    if (this.isPaused) return { error: 'game paused' };
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
      p.guessedCorrectThisRound = false;
      if (!p.isBenjamin && p.guessedBenjaminCorrectly) {
        p.hasGuessed = true;
        this.guessesDone.add(p.id);
      }
    });
    if (this.allNormalsGuessed()) this.guessSubPhase = 'benjamin';
  }

  submitGuess(playerId, guess) {
    if (this.isPaused) return { error: 'game paused' };
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
        p.guessedCorrectThisRound = true;
        p.bonusScore += guessBonus('normal', true, gr, n);
      }
    } else {
      if (this.guessSubPhase !== 'benjamin') return { error: '请等待其他玩家完成猜测' };
      p.pendingGuess = guess.ranking;
    }

    p.hasGuessed = true;
    this.guessesDone.add(playerId);

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

    // Step 1: Sync totalScore (post-guess bonus, pre-coin-settlement)
    this.players.forEach(p => {
      p.totalScore = p.roundScores.reduce((a, b) => a + b, 0) + p.bonusScore;
    });

    // Step 2: Resolve Benjamin's pending ranking guess + capture for log
    const benjamin = [...this.players.values()].find(p => p.isBenjamin);
    let benjaminGuessLog = null;
    if (benjamin?.pendingGuess) {
      const actualRanking = this._currentRanking().filter(id => id !== benjamin.id);
      let correct = 0;
      benjamin.pendingGuess.forEach((id, idx) => {
        if (actualRanking[idx] === id) correct++;
      });
      benjaminGuessLog = {
        guess: benjamin.pendingGuess.map(id => ({ id, name: this.players.get(id)?.name ?? id })),
        actual: actualRanking.map(id => ({ id, name: this.players.get(id)?.name ?? id })),
        correct,
      };
      benjamin.bonusScore += correct;
      benjamin.pendingGuess = null;
      // re-sync after bonus
      this.players.forEach(p => {
        p.totalScore = p.roundScores.reduce((a, b) => a + b, 0) + p.bonusScore;
      });
    }

    // Step 3: Build roundCoins for scoring module
    const playerData = [...this.players.values()].map(p => ({
      id: p.id,
      isBenjamin: p.isBenjamin,
      roundCoins: p.pool.rounds.map((_, i) => p.pool.roundTotal(i)),
    }));
    const roundResult = settleRound(gr, playerData);

    // Step 4: Capture player actions before applying coin scores
    const playerActions = [...this.players.values()].map(p => {
      const personalIdx = p.isBenjamin ? (5 - gr) : (gr - 1);
      const investObj = { ...p.pool.rounds[personalIdx] };
      const investTotal = [10, 5, 1].reduce((s, d) => s + d * (investObj[d] ?? 0), 0);
      return {
        id: p.id,
        name: p.name,
        isBenjamin: p.isBenjamin,
        personalRound: personalIdx + 1,
        investObj,
        investTotal,
        adjustAction: p.lastAdjust ?? { type: 'pass' },
        roundScore: roundResult[p.id]?.roundPoints ?? 0,
        totalScoreBefore: p.totalScore,
        totalScoreAfter: 0, // filled below
      };
    });

    // Apply coin scores
    this.players.forEach(p => {
      const pts = roundResult[p.id]?.roundPoints ?? 0;
      p.roundScores.push(pts);
      p.totalScore = p.roundScores.reduce((a, b) => a + b, 0) + p.bonusScore;
    });

    // Fill totalScoreAfter
    playerActions.forEach(pa => {
      pa.totalScoreAfter = this.players.get(pa.id)?.totalScore ?? 0;
    });

    const correctGuessers = [...this.players.values()]
      .filter(p => !p.isBenjamin && p.guessedCorrectThisRound)
      .map(p => ({ id: p.id, name: p.name }));

    this.roundLog[gr - 1] = { round: gr, playerActions, correctGuessers, benjaminGuess: benjaminGuessLog };
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

  publicState(viewerId) {
    const isMod = this.moderator?.id === viewerId;
    const viewer = isMod ? null : this.players.get(viewerId);
    const n = this.players.size;
    const gr = this.gameRound;

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
        connected: p.connected,
        isBenjamin: (isViewer || isMod || this.phase === 'ended') ? p.isBenjamin : undefined,
        totalScore: (isViewer || isMod || showOthersScore) ? p.totalScore : undefined,
        roundScores: (isViewer || isMod || this.phase === 'ended') ? p.roundScores : undefined,
        bonusScore: (isViewer || isMod || this.phase === 'ended') ? p.bonusScore : undefined,
        pool: (isViewer || this.phase === 'ended') ? p.pool.snapshot() : undefined,
        hasAdjusted: p.hasAdjusted,
        hasActed: p.hasActed,
        hasGuessed: p.hasGuessed,
        guessedBenjaminCorrectly: isViewer ? p.guessedBenjaminCorrectly : undefined,
      };
    });

    let leaderboard = null;
    if (gr >= 3 && this.phase === 'settlement') {
      leaderboard = this._currentRanking()
        .slice(0, 3)
        .map(id => {
          const p = this.players.get(id);
          return { name: p.name, totalScore: p.totalScore };
        });
    }

    let myAdjust = null;
    if (!isMod && inInvest && gr >= 2 && viewer) {
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

    let adjustReveal = null;
    if (inInvest && gr >= 3) {
      adjustReveal = [...this.players.values()]
        .sort((a, b) => b.totalScore - a.totalScore)
        .map(p => ({ name: p.name, totalScore: p.totalScore }));
    }

    const moderatorRoundLog = (isMod && this.phase === 'settlement')
      ? (this.roundLog[gr - 1] ?? null)
      : null;

    return {
      roomId: this.id,
      phase: this.phase,
      actionSubPhase: this.actionSubPhase,
      guessSubPhase: this.guessSubPhase,
      gameRound: gr,
      playerCount: n,
      players: playersPublic,
      leaderboard,
      myAdjust,
      adjustReveal,
      paused: this.isPaused,
      isModerator: isMod,
      moderator: this.moderator ? { name: this.moderator.name, connected: this.moderator.connected } : null,
      isBenjamin: viewer?.isBenjamin,
      benjaminRound: viewer?.isBenjamin ? benjaminRound(gr) : undefined,
      moderatorRoundLog,
    };
  }
}

module.exports = GameRoom;
