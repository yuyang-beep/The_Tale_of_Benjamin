const socket = io();
let state = null;
let myId = null;
let myRoomId = null;

// ── Helpers ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  $('panel-' + name).classList.remove('hidden');
}
function me() { return state?.players?.find(p => p.id === myId); }
function isBenjamin() { return me()?.isBenjamin === true; }
function phaseLabel(phase, subPhase) {
  const base = { lobby:'大厅', free:'自由阶段', action:'行动阶段', guess:'猜测阶段', settlement:'结算', ended:'游戏结束' }[phase] ?? phase;
  if (phase === 'action' && subPhase === 'adjust') return '行动阶段 · 微调';
  if (phase === 'action' && subPhase === 'invest') return '行动阶段 · 投入';
  return base;
}

// ── Lobby ────────────────────────────────────────────────
$('btn-create').onclick = () => {
  const name = $('inp-name').value.trim();
  if (!name) { $('lobby-error').textContent = '请输入名字'; return; }
  socket.emit('create-room', { name }, res => {
    if (res.error) { $('lobby-error').textContent = res.error; return; }
    myRoomId = res.roomId;
    localStorage.setItem('benjamin_session', JSON.stringify({ roomId: res.roomId, playerName: name }));
    showScreen('waiting');
  });
};

$('btn-join').onclick = () => {
  const name = $('inp-name').value.trim();
  const code = $('inp-room').value.trim().toUpperCase();
  if (!name) { $('lobby-error').textContent = '请输入名字'; return; }
  if (!code) { $('lobby-error').textContent = '请输入房间码'; return; }
  socket.emit('join-room', { roomId: code, name }, res => {
    if (res.error) { $('lobby-error').textContent = res.error; return; }
    myRoomId = res.roomId;
    localStorage.setItem('benjamin_session', JSON.stringify({ roomId: res.roomId, playerName: name }));
    showScreen('waiting');
  });
};

// ── Waiting Room ─────────────────────────────────────────
$('btn-start').onclick = () => {
  socket.emit('start-game', {}, res => {
    if (res?.error) alert(res.error);
  });
};

function renderWaiting() {
  $('room-code').textContent = myRoomId;
  const list = $('player-list');
  list.innerHTML = state.players.map(p =>
    `<div class="player-item${p.connected === false ? ' disconnected' : ''}">
      <span>${p.name}${p.connected === false ? ' (离线)' : ''}</span>
      ${p.isHost ? '<span class="badge">主持人</span>' : ''}
    </div>`
  ).join('');
  const isHost = me()?.isHost;
  if (isHost) { show('btn-start'); $('wait-hint').textContent = ''; }
  else hide('btn-start');
  if (!isHost) $('wait-hint').textContent = `等待主持人开始 (${state.players.length} 人已加入)`;
}

// ── Game Header ───────────────────────────────────────────
function renderHeader() {
  $('hdr-round').textContent = `第 ${state.gameRound} 轮`;
  $('hdr-phase').textContent = phaseLabel(state.phase, state.actionSubPhase);
  const id = $('hdr-identity');
  if (state.isBenjamin) {
    id.textContent = `你是本杰明（本轮执行第 ${state.benjaminRound} 轮）`;
    id.className = 'is-benjamin';
  } else {
    id.textContent = '你是普通玩家';
    id.className = 'is-normal';
  }
  renderTimeline();
}

// ── ① 双时间轴 ────────────────────────────────────────────
// Benjamin 逆序 R5→R4→R3→R2→R1；普通玩家顺序 R1→R2→R3→R4→R5
function renderTimeline() {
  const tl = $('hdr-timeline');
  if (!tl || !state) return;

  const gr = state.gameRound;
  const amB = isBenjamin();

  // Personal rounds in the order this player experiences them
  const seq = amB ? [5, 4, 3, 2, 1] : [1, 2, 3, 4, 5];
  const curP = amB ? (6 - gr) : gr;

  const steps = seq.map(r => {
    let cls;
    if (amB)  cls = r > curP ? 'done' : r === curP ? 'current' : 'future';
    else      cls = r < gr   ? 'done' : r === gr   ? 'current' : 'future';
    return `<div class="tl-step ${cls}"><div class="tl-dot"></div><span class="tl-rnum">R${r}</span></div>`;
  }).join('');

  const dirHtml = amB
    ? `<span class="tl-dir benjamin">逆←</span>`
    : `<span class="tl-dir">顺→</span>`;

  tl.innerHTML = `<div class="timeline-bar">${dirHtml}<div class="tl-track">${steps}</div></div>`;
}

// ── Free Phase ────────────────────────────────────────────
function renderFree() {
  showPanel('free');
  const isHost = me()?.isHost;
  if (isHost) show('btn-end-free'); else hide('btn-end-free');
}
$('btn-end-free').onclick = () => {
  socket.emit('end-free-phase', {}, res => { if (res?.error) alert(res.error); });
};

// ── Action Phase ──────────────────────────────────────────
function renderAction() {
  showPanel('action');
  if (state.actionSubPhase === 'adjust') renderAdjust();
  else renderInvest();
}

// Sub-phase 1: adjust previous round ±1
function renderAdjust() {
  const player = me();
  if (!player) return;

  if (player.hasAdjusted) {
    $('coin-status').innerHTML = '';
    $('action-controls').innerHTML = '';
    const pending = state.players.filter(p => p.connected && !p.hasAdjusted);
    const names = pending.map(p => p.name).join('、');
    $('action-wait').textContent = pending.length
      ? `等待 ${names} 完成微调…`
      : '已提交微调，等待其他玩家…';
    show('action-wait');
    return;
  }
  hide('action-wait');

  const pool = player.pool;
  const rem = pool?.remaining ?? { 10:2, 5:4, 1:10 };
  const gr = state.gameRound;
  const amBenjamin = isBenjamin();
  const personalIdx = amBenjamin ? (5 - gr) : (gr - 1);
  const prevIdx = amBenjamin ? personalIdx + 1 : personalIdx - 1;
  const prevBrk = pool?.rounds?.[prevIdx] ?? { 10:0, 5:0, 1:0 };
  const prevTotal = [10,5,1].reduce((s,d) => s + d*(prevBrk[d]??0), 0);
  const MAXC = { 10:2, 5:4, 1:10 };

  $('coin-status').innerHTML = `
    <div class="coin-status">
      <h4>当前剩余金币</h4>
      <div class="coin-row">
        <div class="coin-group"><label>未分配</label>
          <span>10×${rem[10]}　5×${rem[5]}　1×${rem[1]}</span>
        </div>
        <div class="coin-group"><label>剩余总额</label>
          <span style="color:var(--gold)">${pool?.remainingTotal ?? 0}</span>
        </div>
      </div>
    </div>`;

  let selectedAdj = { type: 'pass' };

  $('action-controls').innerHTML = `
    <p class="hint" style="font-weight:600;margin-bottom:.4rem">
      ▸ 微调上轮投入 <span id="adj-label" style="color:var(--gold);font-weight:400">（不调整）</span>
    </p>
    <p class="hint" style="margin-bottom:.4rem;font-size:.85rem">
      上轮投入：10×${prevBrk[10]??0}　5×${prevBrk[5]??0}　1×${prevBrk[1]??0}　共 ${prevTotal} 金币
    </p>
    <p class="hint" style="margin-bottom:.3rem;font-size:.85rem">增 / 减 一枚：</p>
    <div class="denom-btns" id="adj-btns">
      ${[10,5,1].map(d=>`<button class="denom-btn add" data-act="add" data-d="${d}"
        ${rem[d]<=0||(prevBrk[d]??0)>=MAXC[d]?'disabled':''}>+${d}</button>`).join('')}
      ${[10,5,1].map(d=>`<button class="denom-btn remove" data-act="remove" data-d="${d}"
        ${(prevBrk[d]??0)<=0?'disabled':''}>-${d}</button>`).join('')}
      <button class="denom-btn secondary" data-act="pass">不调整</button>
    </div>
    <div class="action-btns" style="margin-top:1rem">
      <button id="btn-confirm-adjust">确认微调</button>
    </div>`;

  $('adj-btns').querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      $('adj-btns').querySelectorAll('[data-act]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const act = btn.dataset.act;
      const d = parseInt(btn.dataset.d);
      selectedAdj = act === 'pass' ? { type: 'pass' } : { type: act, denom: d };
      $('adj-label').textContent = act === 'pass' ? '（不调整）' : `（${act === 'add' ? '+' : '-'}${d} 金币）`;
    };
  });

  $('btn-confirm-adjust').onclick = () => {
    socket.emit('submit-adjust', selectedAdj, res => {
      if (res?.error) alert(res.error);
    });
  };
}

// Sub-phase 2: allocate coins for current round
function renderInvest() {
  const player = me();
  if (!player) return;

  if (player.hasActed) {
    $('coin-status').innerHTML = '';
    $('action-controls').innerHTML = '';
    const pending = state.players.filter(p => p.connected && !p.hasActed);
    const names = pending.map(p => p.name).join('、');
    $('action-wait').textContent = pending.length
      ? `等待 ${names} 完成投入…`
      : '已提交投入，等待其他玩家…';
    show('action-wait');
    return;
  }
  hide('action-wait');

  const pool = player.pool;
  const rem = pool?.remaining ?? { 10:2, 5:4, 1:10 };
  const gr = state.gameRound;
  const amBenjamin = isBenjamin();

  // ── Post-adjust reveal ────────────────────────────────────
  let revealHtml = '';

  // Part A: viewer's own adjust summary (rounds 2+)
  if (state.myAdjust) {
    const adj = state.myAdjust;
    let adjText;
    if (adj.type === 'pass') {
      adjText = '<span style="color:#aaa">不调整</span>';
    } else if (adj.type === 'add') {
      adjText = `<span style="color:#7dc;font-weight:600">+1枚 ${adj.denom} 金币</span>`;
    } else {
      adjText = `<span style="color:#e87;font-weight:600">-1枚 ${adj.denom} 金币</span>`;
    }
    const pr = adj.prevRoundAfter;
    const prTotal = pr ? [10,5,1].reduce((s,d) => s + d*(pr[d]??0), 0) : 0;
    const prLine = pr
      ? `<span style="color:#aaa;font-size:.82rem"> → 上轮共 ${prTotal} 金币（10×${pr[10]??0} 5×${pr[5]??0} 1×${pr[1]??0}）</span>`
      : '';
    revealHtml += `<div class="coin-status" style="margin-bottom:1rem">
      <h4 style="color:var(--gold);margin-bottom:.5rem">▸ 微调结果</h4>
      <p style="margin:.2rem 0">微调：${adjText}${prLine}</p>
      <p style="margin:.2rem 0">当前总积分：<span style="color:var(--gold);font-size:1.1rem;font-weight:700">${adj.myTotalScore ?? 0}</span> 分</p>
    </div>`;
  }

  // Part B: all-player standings + top-3 (rounds 3+)
  if (state.adjustReveal) {
    const scoreRows = state.adjustReveal.map((e, i) => `
      <div class="score-row${e.name === player.name ? ' you' : ''}">
        <span>${i+1}. ${e.name}${e.name === player.name ? ' (你)' : ''}</span>
        <span class="score-pts">${e.totalScore} 分</span>
      </div>`).join('');
    const top3 = state.adjustReveal.slice(0, 3);
    const top3Html = `<div class="leaderboard" style="margin-top:.75rem">
      <h4>▸ 当前前三名</h4>
      ${top3.map((e, i) => `<div class="lb-row">
        <span>${i+1}. ${e.name}</span><span>${e.totalScore} 分</span>
      </div>`).join('')}
    </div>`;
    revealHtml += `<div class="coin-status" style="margin-bottom:1rem">
      <h4 style="color:var(--gold);margin-bottom:.5rem">▸ 积分公示</h4>
      <div class="settlement-scores" style="margin:0">${scoreRows}</div>
      ${top3Html}
    </div>`;
  }

  // ── Coin status ───────────────────────────────────────────
  const coinTitle = gr > 1 ? '可用金币（微调后）' : '可用金币';
  $('coin-status').innerHTML = `
    ${revealHtml}
    <div class="coin-status">
      <h4>${coinTitle}</h4>
      <div class="coin-row">
        <div class="coin-group"><label>未分配</label>
          <span>10×${rem[10]}　5×${rem[5]}　1×${rem[1]}</span>
        </div>
        <div class="coin-group"><label>剩余总额</label>
          <span style="color:var(--gold)">${pool?.remainingTotal ?? 0}</span>
        </div>
      </div>
    </div>`;

  $('action-controls').innerHTML = `
    <p class="hint" style="font-weight:600;margin-bottom:.5rem">▸ 本轮投入金币</p>
    <div class="initial-grid">
      <div class="initial-cell"><label>10金币（最多 ${rem[10]} 枚）</label>
        <input type="number" id="inp-d10" min="0" max="${rem[10]}" value="0"/></div>
      <div class="initial-cell"><label>5金币（最多 ${rem[5]} 枚）</label>
        <input type="number" id="inp-d5" min="0" max="${rem[5]}" value="0"/></div>
      <div class="initial-cell"><label>1金币（最多 ${rem[1]} 枚）</label>
        <input type="number" id="inp-d1" min="0" max="${rem[1]}" value="0"/></div>
    </div>
    <div class="action-btns" style="margin-top:1rem">
      <button id="btn-confirm-invest">确认投入</button>
    </div>`;

  $('btn-confirm-invest').onclick = () => {
    const investObj = {
      10: parseInt($('inp-d10').value) || 0,
      5:  parseInt($('inp-d5').value)  || 0,
      1:  parseInt($('inp-d1').value)  || 0,
    };
    socket.emit('submit-invest', { investObj }, res => {
      if (res?.error) alert(res.error);
    });
  };
}

// ── Guess Phase ───────────────────────────────────────────
let selectedSuspect = null;
let rankingOrder = [];

function renderGuess() {
  showPanel('guess');
  const player = me();
  if (!player) return;

  const gsp = state.guessSubPhase;
  const n = state.playerCount;
  const gr = state.gameRound;
  const others = state.players.filter(p => p.id !== myId);

  // ── Already submitted ─────────────────────────────────────
  if (player.hasGuessed) {
    const waitMsg = (!isBenjamin() && gsp === 'benjamin')
      ? '已提交，等待本杰明猜测排名…'
      : '已提交猜测，等待其他玩家…';
    $('guess-controls').innerHTML = `<p class="hint">${waitMsg}</p>`;
    return;
  }

  if (!isBenjamin()) {
    // ── Normal player sub-phase ───────────────────────────────
    if (gsp !== 'normal') {
      // Shouldn't happen (hasGuessed would be true), safety fallback
      $('guess-controls').innerHTML = '<p class="hint">等待本杰明提交猜测…</p>';
      return;
    }
    // guessedBenjaminCorrectly → server auto-sets hasGuessed; safety display
    if (player.guessedBenjaminCorrectly) {
      $('guess-controls').innerHTML = '<p style="color:var(--green)">你已成功识别本杰明！</p>';
      return;
    }
    const bonusAmt = Math.floor(n / Math.pow(2, gr - 1));
    selectedSuspect = null;
    $('guess-controls').innerHTML = `
      <p class="hint">猜测谁是本杰明（猜对得 <span style="color:var(--gold)">${bonusAmt}</span> 分）</p>
      <div class="guess-player-list" id="suspect-list">
        ${others.map(p => `<button class="guess-player-btn" data-id="${p.id}">${p.name}</button>`).join('')}
      </div>
      <div class="action-btns" style="margin-top:1rem">
        <button id="btn-submit-guess">提交猜测</button>
      </div>`;
    $('suspect-list').querySelectorAll('.guess-player-btn').forEach(btn => {
      btn.onclick = () => {
        $('suspect-list').querySelectorAll('.guess-player-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedSuspect = btn.dataset.id;
      };
    });
    $('btn-submit-guess').onclick = () => {
      if (!selectedSuspect) { alert('请选择一名玩家'); return; }
      socket.emit('submit-guess', { suspectId: selectedSuspect }, res => {
        if (res?.error) alert(res.error);
      });
    };
  } else {
    // ── Benjamin sub-phase ────────────────────────────────────
    if (gsp !== 'benjamin') {
      // Normals haven't all submitted yet; Benjamin waits
      const doneCount = state.players.filter(p => p.id !== myId && p.hasGuessed).length;
      const totalNormals = others.length;
      $('guess-controls').innerHTML = `
        <p class="hint">等待其他玩家完成猜测后，轮到你猜排名…</p>
        <p class="hint" style="color:#aaa;font-size:.85rem">(${doneCount} / ${totalNormals} 已提交)</p>`;
      return;
    }
    // All normals done — show ranking form
    rankingOrder = others.map(p => p.id);
    renderRankList();
    const ctrl = $('guess-controls');
    const submitBtn = document.createElement('div');
    submitBtn.className = 'action-btns';
    submitBtn.style.marginTop = '1rem';
    submitBtn.innerHTML = '<button id="btn-submit-rank">提交排名猜测</button>';
    ctrl.appendChild(submitBtn);
    $('btn-submit-rank').onclick = () => {
      socket.emit('submit-guess', { ranking: rankingOrder }, res => {
        if (res?.error) alert(res.error);
      });
    };
  }
}

function renderRankList() {
  const ctrl = $('guess-controls');
  ctrl.innerHTML = `<p class="hint">拖拽排序：猜测其他玩家当前总积分排名（从高到低，猜对每位 +1 分）</p>
    <div class="rank-list" id="rank-list">
      ${rankingOrder.map((id, i) => {
        const p = state.players.find(x => x.id === id);
        return `<div class="rank-item" draggable="true" data-id="${id}">
          <span class="rank-no">${i+1}</span>
          <span class="rank-handle">⠿</span>
          <span>${p?.name ?? id}</span>
        </div>`;
      }).join('')}
    </div>`;
  enableDrag($('rank-list'));
}

function enableDrag(list) {
  let dragged = null;
  list.querySelectorAll('.rank-item').forEach(item => {
    item.addEventListener('dragstart', () => { dragged = item; item.style.opacity = '.4'; });
    item.addEventListener('dragend', () => { dragged.style.opacity = '1'; dragged = null; });
    item.addEventListener('dragover', e => { e.preventDefault(); });
    item.addEventListener('drop', () => {
      if (!dragged || dragged === item) return;
      const items = [...list.querySelectorAll('.rank-item')];
      const fromIdx = items.indexOf(dragged);
      const toIdx = items.indexOf(item);
      if (fromIdx < toIdx) list.insertBefore(dragged, item.nextSibling);
      else list.insertBefore(dragged, item);
      rankingOrder = [...list.querySelectorAll('.rank-item')].map(el => el.dataset.id);
      list.querySelectorAll('.rank-no').forEach((el, i) => { el.textContent = i + 1; });
    });
  });
}

// ── Settlement ────────────────────────────────────────────
function renderSettlement() {
  showPanel('settlement');
  const player = me();
  const myScores = player?.roundScores ?? [];
  const myTotal = player?.totalScore ?? 0;
  const myBonus = player?.bonusScore ?? 0;

  const scoreRows = state.players
    .slice()
    .sort((a, b) => (b.totalScore ?? -Infinity) - (a.totalScore ?? -Infinity))
    .map(p => `
      <div class="score-row${p.id === myId ? ' you' : ''}${p.connected === false ? ' disconnected' : ''}">
        <span>${p.name}${p.id === myId ? ' (你)' : ''}${p.connected === false ? ' (离线)' : ''}</span>
        <span class="score-pts">${p.totalScore !== undefined ? p.totalScore + ' 分' : '--'}</span>
      </div>`).join('');

  let lbHtml = '';
  if (state.leaderboard) {
    lbHtml = `<div class="leaderboard">
      <h4>▸ 前三名公示</h4>
      ${state.leaderboard.map((e, i) =>
        `<div class="lb-row"><span>${i+1}. ${e.name}</span><span>${e.totalScore} 分</span></div>`
      ).join('')}
    </div>`;
  }

  $('settlement-info').innerHTML = `
    <div class="settlement-scores">${scoreRows}</div>
    <p class="hint">你的积分：本轮 ${myScores[myScores.length-1] ?? 0} 分｜猜测加成 ${myBonus} 分｜总计 ${myTotal} 分</p>
    ${lbHtml}`;

  const isHost = me()?.isHost;
  const isLastRound = state.gameRound >= 5;
  if (isHost) {
    $('btn-next-round').textContent = isLastRound ? '结束游戏' : '下一轮';
    show('btn-next-round');
  } else {
    hide('btn-next-round');
  }
}

$('btn-next-round').onclick = () => {
  socket.emit('next-round', {}, res => { if (res?.error) alert(res.error); });
};

// ── ② 命运回放 + Ended ────────────────────────────────────
function renderEnded() {
  showPanel('ended');
  localStorage.removeItem('benjamin_session');

  const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
  const benj   = state.players.find(p => p.isBenjamin);
  const ROMAN  = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ','Ⅺ','Ⅻ'];

  // Final leaderboard
  $('final-scores').innerHTML = sorted.map((p, i) =>
    `<div class="final-row${p.id === myId ? ' you' : ''}">
      <span class="final-rank">${ROMAN[i] ?? i+1}</span>
      <span class="final-name">${p.name}${p.id === myId ? ' (你)' : ''}${
        p.isBenjamin ? ' <span style="font-size:.75rem;color:var(--gold-dim)">· 本杰明</span>' : ''
      }</span>
      <span class="final-score">${p.totalScore} 分</span>
    </div>`
  ).join('');

  // Benjamin reveal
  $('benjamin-reveal').innerHTML = benj
    ? `<span style="letter-spacing:.06em">命运逆行者——<em style="color:var(--gold);font-style:normal">${benj.name}</em></span>`
    : '';

  // Replay — remove stale then re-insert
  $('panel-ended').querySelector('.replay-section')?.remove();
  $('panel-ended').insertAdjacentHTML('beforeend', buildReplay(sorted));
}

function buildReplay(players) {
  const ROMAN = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ'];
  let html = `<div class="replay-section"><p class="replay-title">── 命运回放 ──</p>`;

  for (let gr = 1; gr <= 5; gr++) {
    html += `<div class="replay-round">
      <div class="replay-round-hdr">第 ${ROMAN[gr-1]} 局</div>`;

    players.forEach(p => {
      const pIdx    = p.isBenjamin ? (5 - gr) : (gr - 1);
      const rd      = p.pool?.rounds?.[pIdx] ?? {};
      const rdTotal = [10,5,1].reduce((s,d) => s + d*(rd[d]??0), 0);
      const rdScore = p.roundScores?.[gr-1] ?? '—';
      const pRound  = p.isBenjamin ? (6 - gr) : gr;
      const parts   = [];
      if (rd[10] > 0) parts.push(`${rd[10]}×10`);
      if (rd[5]  > 0) parts.push(`${rd[5]}×5`);
      if (rd[1]  > 0) parts.push(`${rd[1]}×1`);
      const coinsStr = parts.length ? `${rdTotal}金（${parts.join(' ')}）` : '—';
      const scoreStr = typeof rdScore === 'number'
        ? (rdScore >= 0 ? `+${rdScore}` : `${rdScore}`)
        : rdScore;

      html += `<div class="replay-row${p.id === myId ? ' you' : ''}">
        <span>${p.name}${p.isBenjamin
          ? `<span class="rr-b">B·R${pRound}</span>` : ''}</span>
        <span class="rr-coins">${coinsStr}</span>
        <span class="rr-score">${scoreStr}</span>
      </div>`;
    });

    html += `</div>`;
  }

  // Bonus row
  const withBonus = players.filter(p => (p.bonusScore ?? 0) > 0);
  if (withBonus.length) {
    html += `<div class="replay-round">
      <div class="replay-round-hdr">猜测加成</div>`;
    withBonus.forEach(p => {
      html += `<div class="replay-row${p.id === myId ? ' you' : ''}">
        <span>${p.name}</span>
        <span class="rr-coins">猜测正确</span>
        <span class="rr-score">+${p.bonusScore}</span>
      </div>`;
    });
    html += `</div>`;
  }

  html += '</div>';
  return html;
}

// ── Connection management ─────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
  // Hide reconnecting banner
  const banner = document.getElementById('reconnect-banner');
  if (banner) banner.classList.add('hidden');
  // Always re-register with the server on every (re)connect.
  // Socket ID changes after disconnect; server needs the new ID
  // to broadcast state to this client — do NOT gate on myRoomId.
  const saved = JSON.parse(localStorage.getItem('benjamin_session') || 'null');
  if (saved) {
    socket.emit('reconnect-room', { roomId: saved.roomId, name: saved.playerName }, res => {
      if (res.ok) {
        myRoomId = res.roomId;
      } else {
        myRoomId = null;
        localStorage.removeItem('benjamin_session');
      }
    });
  }
});

socket.on('disconnect', () => {
  if (myRoomId) {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.classList.remove('hidden');
  }
});

socket.on('state', newState => {
  state = newState;

  if (state.phase === 'lobby' || state.phase === 'waiting') {
    if (!myRoomId) { showScreen('lobby'); return; }
    showScreen('waiting');
    renderWaiting();
    return;
  }

  if (state.phase === 'free' && state.gameRound === 1 && !myRoomId) {
    // first state after start
  }

  if (['free','action','guess','settlement','ended'].includes(state.phase)) {
    showScreen('game');
    renderHeader();
    if (state.phase === 'free') renderFree();
    else if (state.phase === 'action') renderAction();
    else if (state.phase === 'guess') renderGuess();
    else if (state.phase === 'settlement') renderSettlement();
    else if (state.phase === 'ended') renderEnded();
  } else {
    showScreen('waiting');
    renderWaiting();
  }
});
