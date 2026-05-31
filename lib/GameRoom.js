const CoinPool = require('./CoinPool');
const { settleRound, guessBonus, benjaminRound } = require('./Scoring');

const PHASES = ['lobby', 'free', 'action', 'guess', 'settlement', 'ended'];

class Player {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.isBenjamin = false;
    this.pool = new CoinPool();
    // roundCoins[i] = coins invested in personal round i+1
    // Benjamin fills index 4,3,2,1,0 (rounds 5→1); normals fill 0,1,2,3,4
    this.roundCoins = [0, 0, 0, 0, 0];
    this.totalScore = 0;
    this.roundScores = [];       // points earned each game round
    this.bonusScore = 0;
    this.hasActed = false;
    this.hasGuessed = false;
    this.guessedBenjaminCorrectly = false;
    this.pendingGuess = null;    // benjamin's stored ranking guess
    this.connected = true;
  }

  get personalRoundIndex() {
    // returns 0-based index into roundCoins for the current game round
    // normal: gameRound-1; benjamin: 5-gameRound (i.e. 6-gameRound-1)
    return this._personalRoundIndex;
  }
}

class GameRoom {
  constructor(roomId) {
    this.id = roomId;
    this.players = new Map(); // id → Player
    this.phase = 'waiting';
    this.gameRound = 0;       // 1-5 during game
    this.hostId = null;
    this.actionsDone = new Set();
    this.guessesDone = new Set();
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
    // Assign Benjamin randomly
    const ids = [...this.players.keys()];
    const benjIdx = Math.floor(Math.random() * ids.length);
    ids.forEach((id, i) => {
      this.players.get(id).isBenjamin = (i === benjIdx);
    });
    this.gameRound = 1;
    this.phase = 'free';
    return { ok: true };
  }

  beginAction() {
    this.phase = 'action';
    this.actionsDone.clear();
    this.players.forEach(p => { p.hasActed = false; });
  }

  // action: { type: 'initial'|'add'|'remove'|'pass', denom?: number, investObj?: {...} }
  submitAction(playerId, action) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'player not found' };
    if (this.phase !== 'action') return { error: 'not action phase' };
    if (p.hasActed) return { error: 'already acted' };

    const gr = this.gameRound;
    const personalIdx = p.isBenjamin ? (5 - gr) : (gr - 1); // 0-based

    let err = null;
    if (gr === 1) {
      if (action.type !== 'initial') return { error: 'round 1 requires initial placement' };
      err = p.pool.setInitial(action.investObj ?? {});
    } else {
      if (action.type === 'add') err = p.pool.addCoin(action.denom);
      else if (action.type === 'remove') err = p.pool.removeCoin(action.denom);
      else if (action.type === 'pass') { /* no-op */ }
      else return { error: 'unknown action type' };
    }
    if (err) return { error: err };

    p.roundCoins[personalIdx] = p.pool.investedTotal;
    p.hasActed = true;
    this.actionsDone.add(playerId);
    return { ok: true };
  }

  allActed() {
    return [...this.players.values()].every(p => p.hasActed || !p.connected);
  }

  beginGuess() {
    if (this.gameRound > 3) { this.beginSettlement(); return; }
    this.phase = 'guess';
    this.guessesDone.clear();
    this.players.forEach(p => { p.hasGuessed = false; });
  }

  // Normal player guesses Benjamin's id
  // Benjamin guesses ranking array [id1, id2, ...] ordered by predicted rank
  submitGuess(playerId, guess) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'player not found' };
    if (this.phase !== 'guess') return { error: 'not guess phase' };
    if (p.hasGuessed) return { error: 'already guessed' };

    const n = this.players.size;
    const gr = this.gameRound;

    if (!p.isBenjamin) {
      // guess = { suspectId }
      if (p.guessedBenjaminCorrectly) { p.hasGuessed = true; this.guessesDone.add(playerId); return { ok: true }; }
      const correct = guess.suspectId === this._benjaminId();
      if (correct) {
        p.guessedBenjaminCorrectly = true;
        p.bonusScore += guessBonus('normal', true, gr, n);
      }
    } else {
      // Store Benjamin's ranking prediction — resolved in beginSettlement
      // after all normal players' guess bonuses are applied
      p.pendingGuess = guess.ranking;
    }

    p.hasGuessed = true;
    this.guessesDone.add(playerId);
    return { ok: true };
  }

  allGuessed() {
    return [...this.players.values()].every(p => p.hasGuessed || !p.connected);
  }

  beginSettlement() {
    this.phase = 'settlement';
    const gr = this.gameRound;

    // Step 1: Sync totalScore with all previous round scores + guess bonuses so far
    // This gives the ranking Benjamin was predicting (post-guess, pre-coin-settlement)
    this.players.forEach(p => {
      p.totalScore = p.roundScores.reduce((a, b) => a + b, 0) + p.bonusScore;
    });

    // Step 2: Resolve Benjamin's pending ranking guess against updated ranking
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

    // Step 3: Calculate this round's coin-ranking scores
    const playerData = [...this.players.values()].map(p => ({
      id: p.id,
      isBenjamin: p.isBenjamin,
      roundCoins: [...p.roundCoins],
    }));
    const roundResult = settleRound(gr, playerData);

    // Step 4: Apply coin scores and compute final totalScore for this round
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
  }

  // Returns ordered array of player ids by current total score (desc)
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

    // Other players' scores hidden in rounds 1-2; visible from round 3+ or game end
    const showOthersScore = (gr >= 3 && this.phase === 'settlement') || this.phase === 'ended';

    const playersPublic = [...this.players.values()].map(p => {
      const isViewer = p.id === viewerId;
      return {
        id: p.id,
        name: p.name,
        isHost: p.id === this.hostId,
        connected: p.connected,
        isBenjamin: (isViewer || this.phase === 'ended') ? p.isBenjamin : undefined,
        totalScore: (isViewer || showOthersScore) ? p.totalScore : undefined,
        roundScores: isViewer ? p.roundScores : undefined,
        bonusScore: isViewer ? p.bonusScore : undefined,
        pool: isViewer ? p.pool.snapshot() : undefined,
        hasActed: p.hasActed,
        hasGuessed: p.hasGuessed,
        guessedBenjaminCorrectly: isViewer ? p.guessedBenjaminCorrectly : undefined,
      };
    });

    // Top-3 leaderboard visible from settlement of round 3+
    let leaderboard = null;
    if (gr >= 3 && this.phase === 'settlement') {
      leaderboard = this._currentRanking()
        .slice(0, 3)
        .map(id => {
          const p = this.players.get(id);
          return { name: p.name, totalScore: p.totalScore };
        });
    }

    return {
      roomId: this.id,
      phase: this.phase,
      gameRound: gr,
      playerCount: n,
      players: playersPublic,
      leaderboard,
      isBenjamin: viewer?.isBenjamin,
      benjaminRound: viewer?.isBenjamin ? benjaminRound(gr) : undefined,
    };
  }
}

module.exports = GameRoom;
