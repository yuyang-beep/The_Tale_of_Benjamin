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
function phaseLabel(phase) {
  return { lobby:'大厅', free:'自由阶段', action:'行动阶段', guess:'猜测阶段', settlement:'结算', ended:'游戏结束' }[phase] ?? phase;
}

// ── Lobby ────────────────────────────────────────────────
$('btn-create').onclick = () => {
  const name = $('inp-name').value.trim();
  if (!name) { $('lobby-error').textContent = '请输入名字'; return; }
  socket.emit('create-room', { name }, res => {
    if (res.error) { $('lobby-error').textContent = res.error; return; }
    myRoomId = res.roomId;
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
    `<div class="player-item">
      <span>${p.name}</span>
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
  $('hdr-phase').textContent = phaseLabel(state.phase);
  const id = $('hdr-identity');
  if (state.isBenjamin) {
    id.textContent = `你是本杰明（本轮执行第 ${state.benjaminRound} 轮）`;
    id.className = 'is-benjamin';
  } else {
    id.textContent = '你是普通玩家';
    id.className = 'is-normal';
  }
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
  const player = me();
  if (!player) return;

  if (player.hasActed) {
    $('coin-status').innerHTML = '';
    $('action-controls').innerHTML = '';
    show('action-wait');
    return;
  }
  hide('action-wait');

  const pool = player.pool ?? { unused: {10:2,5:4,1:10}, invested: {10:0,5:0,1:0}, total: 0 };
  $('coin-status').innerHTML = `
    <div class="coin-status">
      <h4>金币状态</h4>
      <div class="coin-row">
        <div class="coin-group"><label>未投入</label>
          <span>10×${pool.unused[10]}　5×${pool.unused[5]}　1×${pool.unused[1]}</span>
        </div>
        <div class="coin-group"><label>已投入</label>
          <span>10×${pool.invested[10]}　5×${pool.invested[5]}　1×${pool.invested[1]}</span>
        </div>
        <div class="coin-group"><label>本轮总额</label>
          <span style="color:var(--gold)">${pool.total}</span>
        </div>
      </div>
    </div>`;

  const ctrl = $('action-controls');
  if (state.gameRound === 1) {
    ctrl.innerHTML = `
      <p class="hint">第1轮：自由决定投入金币</p>
      <div class="initial-grid">
        <div class="initial-cell"><label>10金币（共2枚）</label>
          <input type="number" id="inp-d10" min="0" max="2" value="0"/></div>
        <div class="initial-cell"><label>5金币（共4枚）</label>
          <input type="number" id="inp-d5" min="0" max="4" value="0"/></div>
        <div class="initial-cell"><label>1金币（共10枚）</label>
          <input type="number" id="inp-d1" min="0" max="10" value="0"/></div>
      </div>
      <div class="action-btns"><button id="btn-confirm-initial">确认投入</button></div>`;
    $('btn-confirm-initial').onclick = () => {
      const investObj = {
        10: parseInt($('inp-d10').value) || 0,
        5:  parseInt($('inp-d5').value)  || 0,
        1:  parseInt($('inp-d1').value)  || 0,
      };
      socket.emit('submit-action', { type: 'initial', investObj }, res => {
        if (res?.error) alert(res.error);
      });
    };
  } else {
    ctrl.innerHTML = `
      <p class="hint">调整投币（±1枚，或不调整）</p>
      <p class="hint" style="margin-bottom:.5rem">增加一枚未投入金币：</p>
      <div class="denom-btns">
        ${[10,5,1].map(d => `<button class="denom-btn add" data-act="add" data-d="${d}">+${d}</button>`).join('')}
      </div>
      <p class="hint" style="margin:.75rem 0 .5rem">撤回一枚已投入金币：</p>
      <div class="denom-btns">
        ${[10,5,1].map(d => `<button class="denom-btn remove" data-act="remove" data-d="${d}">-${d}</button>`).join('')}
      </div>
      <div class="action-btns" style="margin-top:1rem">
        <button id="btn-pass-action" class="secondary">不调整（维持原样）</button>
      </div>`;
    ctrl.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        const type = btn.dataset.act;
        const denom = parseInt(btn.dataset.d);
        socket.emit('submit-action', { type, denom }, res => {
          if (res?.error) alert(res.error);
        });
      };
    });
    $('btn-pass-action').onclick = () => {
      socket.emit('submit-action', { type: 'pass' }, res => {
        if (res?.error) alert(res.error);
      });
    };
  }
}

// ── Guess Phase ───────────────────────────────────────────
let selectedSuspect = null;
let rankingOrder = [];

function renderGuess() {
  showPanel('guess');
  const player = me();
  if (!player) return;

  if (player.hasGuessed) {
    $('guess-controls').innerHTML = '<p class="hint">已提交猜测，等待其他玩家…</p>';
    return;
  }

  const others = state.players.filter(p => p.id !== myId);

  if (!isBenjamin()) {
    // Normal player: pick who is Benjamin
    if (player.guessedBenjaminCorrectly) {
      $('guess-controls').innerHTML = '<p style="color:var(--green)">你已成功识别本杰明！</p>';
      return;
    }
    selectedSuspect = null;
    $('guess-controls').innerHTML = `
      <p class="hint">猜测谁是本杰明（第${state.gameRound}轮${['','n','n/2','n/4'][state.gameRound]}分）</p>
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
    // Benjamin: rank other players
    rankingOrder = others.map(p => p.id);
    renderRankList();
    const ctrl = $('guess-controls');
    const submitBtn = document.createElement('div');
    submitBtn.className = 'action-btns';
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
  ctrl.innerHTML = `<p class="hint">拖拽排序：猜测本轮其他玩家金币排名（从高到低）</p>
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
    .sort((a, b) => b.totalScore - a.totalScore)
    .map(p => `
      <div class="score-row${p.id === myId ? ' you' : ''}">
        <span>${p.name}${p.id === myId ? ' (你)' : ''}</span>
        <span class="score-pts">${p.totalScore} 分</span>
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
  if (isHost && state.gameRound < 5) show('btn-next-round');
  else hide('btn-next-round');
  if (state.gameRound >= 5) {
    hide('btn-next-round');
    // trigger end
    socket.emit('next-round', {});
  }
}

$('btn-next-round').onclick = () => {
  socket.emit('next-round', {}, res => { if (res?.error) alert(res.error); });
};

// ── Ended ─────────────────────────────────────────────────
function renderEnded() {
  showPanel('ended');
  const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
  $('final-scores').innerHTML = sorted.map((p, i) =>
    `<div class="final-row">
      <span>${i+1}. ${p.name}${p.id === myId ? ' (你)' : ''}</span>
      <span>${p.totalScore} 分</span>
    </div>`).join('');
  const benj = state.players.find(p => p.isBenjamin);
  $('benjamin-reveal').textContent = benj ? `本杰明是：${benj.name}` : '';
}

// ── State update ──────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('state', newState => {
  state = newState;

  if (state.phase === 'lobby') {
    showScreen('lobby');
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
