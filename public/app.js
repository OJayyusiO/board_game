/* global io */
(() => {
  const socket = io({ transports: ['websocket', 'polling'] });

  // ---------- State ----------
  let myPlayerId = localStorage.getItem('flip7_pid') || null;
  let myName = localStorage.getItem('flip7_name') || '';
  let currentRoom = null;
  let state = null;
  let lastEventSeq = 0;
  let lastCardIds = new Set();
  let hasRenderedLanes = false;

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const screens = ['home', 'room', 'game'];
  function showScreen(name) {
    screens.forEach(s => $('screen-' + s).classList.toggle('hidden', s !== name));
  }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  // ---------- Card rendering ----------
  const ACTION_ICON = { freeze: '❄', flip3: '↻', second_chance: '⛨' };
  const ACTION_LABEL = { freeze: 'Freeze', flip3: 'Flip 3', second_chance: '2nd Chance' };

  function cardEl(card, opts = {}) {
    const div = document.createElement('div');
    div.className = 'card';
    if (opts.large) div.classList.add('size-lg');
    if (opts.duplicate) div.classList.add('duplicate');
    if (card.id) div.dataset.cardId = card.id;
    if (card.kind === 'number') {
      div.classList.add('n-' + card.value);
      div.textContent = card.value;
    } else if (card.kind === 'modifier') {
      div.classList.add('modifier');
      if (card.mod === 'plus') {
        div.classList.add('mod-plus');
        div.textContent = '+' + card.value;
      } else {
        div.classList.add('mod-x2');
        div.textContent = '×2';
      }
    } else if (card.kind === 'action') {
      div.classList.add('action-' + card.action);
      const icon = document.createElement('span');
      icon.className = 'card-action-icon';
      icon.textContent = ACTION_ICON[card.action] || '?';
      div.appendChild(icon);
    }
    return div;
  }

  function statusIcon(status) {
    return ({ active: '', stayed: '✓', busted: '💥', frozen: '❄', flip7: '🎉' })[status] || '';
  }

  // ---------- Render lanes ----------
  function renderLanes() {
    const lanesEl = $('lanes');
    lanesEl.innerHTML = '';
    if (!state) return;

    // Order: self first, then others in seat order
    const ordered = [];
    const self = state.players.find(p => p.id === myPlayerId);
    if (self) ordered.push(self);
    for (const p of state.players) if (p.id !== myPlayerId) ordered.push(p);

    const newCardIds = new Set();
    for (const p of ordered) {
      const lane = state.lanes[p.id];
      if (!lane) continue;
      const laneEl = document.createElement('div');
      laneEl.className = 'lane is-' + lane.status;
      if (state.activePlayerId === p.id) laneEl.classList.add('is-active');
      if (p.id === myPlayerId) laneEl.classList.add('is-self');

      const header = document.createElement('div');
      header.className = 'lane-header';
      const nameWrap = document.createElement('div');
      nameWrap.className = 'lane-name';
      const nameText = document.createElement('span');
      nameText.className = 'name-text';
      nameText.textContent = p.name;
      nameWrap.appendChild(nameText);
      if (p.id === myPlayerId) {
        const tag = document.createElement('span');
        tag.className = 'you-tag';
        tag.textContent = 'YOU';
        nameWrap.appendChild(tag);
      }
      const sIcon = statusIcon(lane.status);
      if (sIcon) {
        const ic = document.createElement('span');
        ic.className = 'lane-status-icon';
        ic.textContent = sIcon;
        nameWrap.appendChild(ic);
      }
      if (!p.connected) {
        const dc = document.createElement('span');
        dc.className = 'badge disconnected';
        dc.textContent = 'offline';
        nameWrap.appendChild(dc);
      }
      header.appendChild(nameWrap);

      const scores = document.createElement('div');
      scores.className = 'lane-scores';
      if (lane.hasSecondChance) {
        const sc = document.createElement('span');
        sc.className = 'sc-pip';
        sc.title = 'Second Chance';
        sc.textContent = '⛨';
        scores.appendChild(sc);
      }
      const rs = document.createElement('span');
      rs.className = 'round-score' + (lane.roundScore === 0 ? ' is-zero' : '');
      rs.textContent = '+' + lane.roundScore;
      scores.appendChild(rs);
      const ts = document.createElement('span');
      ts.className = 'total-score';
      ts.textContent = p.totalScore;
      scores.appendChild(ts);
      header.appendChild(scores);
      laneEl.appendChild(header);

      const cardsEl = document.createElement('div');
      cardsEl.className = 'lane-cards';
      const isSelf = p.id === myPlayerId;
      const allCards = [
        ...lane.numbers.map(v => ({ id: 'n-' + p.id + '-' + v, kind: 'number', value: v })),
        ...lane.modifiers.map((m, i) => ({ ...m, id: m.id || ('m-' + p.id + '-' + i) })),
      ];
      if (allCards.length === 0) cardsEl.classList.add('empty');
      for (const c of allCards) {
        const el = cardEl(c, { large: isSelf });
        const key = c.id;
        // On the very first render, suppress animations (e.g. mid-game reconnect).
        // Otherwise animate any card we haven't seen before.
        const isNew = !lastCardIds.has(key);
        if (!hasRenderedLanes || !isNew) {
          el.style.animation = 'none';
        }
        newCardIds.add(key);
        cardsEl.appendChild(el);
      }
      laneEl.appendChild(cardsEl);
      lanesEl.appendChild(laneEl);
    }
    lastCardIds = newCardIds;
    hasRenderedLanes = true;
  }

  // ---------- Render action bar ----------
  function renderActionBar() {
    const bar = $('action-bar');
    bar.innerHTML = '';
    if (!state || state.phase !== 'playing') return;

    const isMyTurn = state.activePlayerId === myPlayerId;
    const myLane = state.lanes[myPlayerId];

    if (state.pendingAction && state.pendingAction.byPlayerId === myPlayerId) {
      // Should be handled by target modal; show prompt anyway
      const status = document.createElement('div');
      status.className = 'action-status';
      status.textContent = 'Choose a target above ↑';
      bar.appendChild(status);
      return;
    }

    if (state.pendingAction) {
      const byName = state.players.find(p => p.id === state.pendingAction.byPlayerId)?.name || '?';
      const status = document.createElement('div');
      status.className = 'action-status';
      status.innerHTML = `<span class="turn-name">${escape(byName)}</span> is choosing a target…`;
      bar.appendChild(status);
      return;
    }

    if (isMyTurn) {
      const isForced = state.activeFrame?.type === 'forcedDraws';
      if (isForced) {
        const pill = document.createElement('div');
        pill.className = 'action-status';
        pill.innerHTML = `<span class="forced-pill">⚡ Forced flip — ${state.activeFrame.remaining} left</span>`;
        bar.appendChild(pill);
        const buttons = document.createElement('div');
        buttons.className = 'action-buttons';
        const hit = document.createElement('button');
        hit.className = 'btn btn-danger btn-lg';
        hit.textContent = 'FLIP!';
        hit.onclick = doHit;
        buttons.appendChild(hit);
        bar.appendChild(buttons);
      } else {
        const status = document.createElement('div');
        status.className = 'action-status';
        status.textContent = 'Your turn';
        bar.appendChild(status);
        const buttons = document.createElement('div');
        buttons.className = 'action-buttons';
        const hit = document.createElement('button');
        hit.className = 'btn btn-danger btn-lg';
        hit.textContent = 'HIT';
        hit.onclick = doHit;
        const stay = document.createElement('button');
        stay.className = 'btn btn-success btn-lg';
        stay.textContent = 'STAY';
        stay.disabled = (myLane?.numbers.length === 0 && myLane?.modifiers.length === 0);
        stay.onclick = doStay;
        buttons.appendChild(hit);
        buttons.appendChild(stay);
        bar.appendChild(buttons);
      }
    } else {
      const activeName = state.players.find(p => p.id === state.activePlayerId)?.name || '?';
      const isForced = state.activeFrame?.type === 'forcedDraws';
      const status = document.createElement('div');
      status.className = 'action-status';
      status.innerHTML = isForced
        ? `<span class="turn-name">${escape(activeName)}</span> must flip ${state.activeFrame.remaining} more`
        : `Waiting for <span class="turn-name">${escape(activeName)}</span>…`;
      bar.appendChild(status);
    }
  }

  // ---------- Render top bar ----------
  function renderTop() {
    if (!state) return;
    $('round-num').textContent = 'Round ' + state.round;
    $('target-score').textContent = state.targetScore;
    $('deck-count').textContent = state.deckCount;
  }

  // ---------- Render lobby ----------
  function renderLobby() {
    if (!state) return;
    $('room-code').textContent = currentRoom || '—';
    const list = $('lobby-players');
    list.innerHTML = '';
    for (const p of state.players) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name + (p.id === myPlayerId ? ' (you)' : '');
      li.appendChild(name);
      const right = document.createElement('span');
      if (p.isHost) {
        const b = document.createElement('span');
        b.className = 'badge host';
        b.textContent = 'HOST';
        right.appendChild(b);
      }
      if (!p.connected) {
        const b = document.createElement('span');
        b.className = 'badge disconnected';
        b.textContent = 'offline';
        right.appendChild(b);
      }
      li.appendChild(right);
      list.appendChild(li);
    }
    const me = state.players.find(p => p.id === myPlayerId);
    const isHost = me?.isHost;
    const startBtn = $('btn-start');
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = state.players.length < 2;
    $('lobby-status').textContent = isHost
      ? (state.players.length < 2 ? 'Waiting for at least 2 players…' : `${state.players.length} players ready`)
      : 'Waiting for host to start…';
  }

  // ---------- Modals ----------
  function renderRoundEndModal() {
    if (!state || state.phase !== 'roundEnd' || !state.lastRoundSummary) {
      hide($('modal-round-end'));
      return;
    }
    const list = $('round-end-list');
    list.innerHTML = '';
    const sorted = [...state.lastRoundSummary].sort((a, b) => b.totalScore - a.totalScore);
    for (const row of sorted) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.className = 'name-block';
      const ic = document.createElement('span');
      ic.textContent = statusIcon(row.status) || '·';
      left.appendChild(ic);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = row.name;
      left.appendChild(nm);
      li.appendChild(left);
      const right = document.createElement('div');
      right.className = 'scores-block';
      const d = document.createElement('span');
      d.className = 'delta' + (row.roundScore === 0 ? ' zero' : '');
      d.textContent = '+' + row.roundScore;
      right.appendChild(d);
      const t = document.createElement('span');
      t.className = 'total';
      t.textContent = row.totalScore;
      right.appendChild(t);
      li.appendChild(right);
      list.appendChild(li);
    }
    const me = state.players.find(p => p.id === myPlayerId);
    const isHost = me?.isHost;
    const btn = $('btn-next-round');
    btn.classList.toggle('hidden', !isHost);
    $('round-end-status').textContent = isHost ? '' : 'Waiting for host to advance…';
    show($('modal-round-end'));
  }

  function renderGameOverModal() {
    if (!state || state.phase !== 'gameOver') {
      hide($('modal-game-over'));
      return;
    }
    const winnerName = state.players.find(p => state.winnerIds.includes(p.id))?.name || '?';
    $('game-over-title').textContent = winnerName + ' wins!';
    const list = $('game-over-list');
    list.innerHTML = '';
    const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
    for (const p of sorted) {
      const li = document.createElement('li');
      if (state.winnerIds.includes(p.id)) li.classList.add('winner');
      const left = document.createElement('div');
      left.className = 'name-block';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      left.appendChild(nm);
      li.appendChild(left);
      const right = document.createElement('div');
      right.className = 'scores-block';
      const t = document.createElement('span');
      t.className = 'total';
      t.textContent = p.totalScore;
      right.appendChild(t);
      li.appendChild(right);
      list.appendChild(li);
    }
    const me = state.players.find(p => p.id === myPlayerId);
    const isHost = me?.isHost;
    $('btn-new-game').classList.toggle('hidden', !isHost);
    show($('modal-game-over'));
  }

  function renderTargetModal() {
    const modal = $('modal-target');
    if (!state || !state.pendingAction || state.pendingAction.byPlayerId !== myPlayerId) {
      hide(modal);
      return;
    }
    const action = state.pendingAction.type;
    $('target-title').textContent = ACTION_LABEL[action];
    const subtitles = {
      freeze: 'Pick a player to freeze. They bank their score and are out for the round.',
      flip3: 'Pick a player to force-flip 3 cards.',
      second_chance: 'You already have a Second Chance — gift this one to another active player.',
    };
    $('target-subtitle').textContent = subtitles[action] || '';
    const list = $('target-list');
    list.innerHTML = '';
    for (const p of state.players) {
      const lane = state.lanes[p.id];
      if (!lane || lane.status !== 'active') continue;
      // SC cannot target self or anyone who already has one
      if (action === 'second_chance' && (p.id === myPlayerId || lane.hasSecondChance)) continue;
      const btn = document.createElement('button');
      btn.className = 'target-btn';
      if (p.id === myPlayerId) btn.classList.add('is-self');
      const left = document.createElement('span');
      left.textContent = p.name + (p.id === myPlayerId ? ' (you)' : '');
      btn.appendChild(left);
      const right = document.createElement('span');
      right.textContent = '+' + lane.roundScore;
      right.style.color = '#94a3b8';
      btn.appendChild(right);
      btn.onclick = () => {
        socket.emit('chooseTarget', { targetId: p.id }, (r) => {
          if (!r?.ok) toast(r?.error || 'Failed');
        });
      };
      list.appendChild(btn);
    }
    show(modal);
  }

  // ---------- Event banner ----------
  function flashEvent(text, kind = '', duration = 1400) {
    const banner = $('event-banner');
    const t = $('event-banner-text');
    t.textContent = text;
    banner.className = 'event-banner ' + kind;
    requestAnimationFrame(() => banner.classList.add('visible'));
    clearTimeout(flashEvent._t);
    flashEvent._t = setTimeout(() => {
      banner.classList.remove('visible');
      setTimeout(() => banner.classList.add('hidden'), 250);
    }, duration);
    banner.classList.remove('hidden');
  }

  function handleEvent(ev) {
    if (!ev || ev.seq <= lastEventSeq) return;
    lastEventSeq = ev.seq;
    const playerName = (id) => state?.players.find(p => p.id === id)?.name || '';
    switch (ev.type) {
      case 'bust': {
        const name = playerName(ev.playerId);
        flashEvent((ev.playerId === myPlayerId ? 'YOU BUSTED' : `${name} busted`), 'bust');
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
        break;
      }
      case 'flip7':
        flashEvent('FLIP 7!', 'flip7', 1800);
        if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
        break;
      case 'freeze':
        flashEvent('FROZEN ❄', 'freeze', 1100);
        break;
      case 'secondChanceUsed':
        flashEvent('Saved by 2nd Chance', 'sc', 1100);
        break;
      case 'gainSecondChance':
        if (ev.playerId === myPlayerId) toast('You got a Second Chance');
        break;
      case 'roundStart':
        flashEvent('Round ' + ev.round, '', 900);
        break;
      case 'gameOver':
        // handled by modal
        break;
    }
  }

  function toast(text, ms = 2000) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- Render dispatch ----------
  function render() {
    if (!state) {
      showScreen('home');
      return;
    }
    if (state.phase === 'lobby') {
      showScreen('room');
      renderLobby();
    } else {
      showScreen('game');
      renderTop();
      renderLanes();
      renderActionBar();
    }
    renderRoundEndModal();
    renderGameOverModal();
    renderTargetModal();
  }

  // ---------- Actions ----------
  function doHit() {
    socket.emit('hit', null, (r) => { if (!r?.ok) toast(r?.error || 'Cannot hit'); });
  }
  function doStay() {
    socket.emit('stay', null, (r) => { if (!r?.ok) toast(r?.error || 'Cannot stay'); });
  }

  // ---------- Home screen wiring ----------
  $('name-input').value = myName;
  $('name-input').addEventListener('input', e => {
    myName = e.target.value;
    localStorage.setItem('flip7_name', myName);
  });
  $('code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('name-input').value.trim();
    if (!name) { $('home-error').textContent = 'Enter your name first'; return; }
    $('home-error').textContent = '';
    socket.emit('createRoom', { name, playerId: myPlayerId }, (res) => {
      if (!res?.ok) { $('home-error').textContent = res?.error || 'Failed'; return; }
      currentRoom = res.code;
      myPlayerId = res.playerId;
      localStorage.setItem('flip7_pid', myPlayerId);
      history.replaceState(null, '', '#' + currentRoom);
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('name-input').value.trim();
    const code = $('code-input').value.trim().toUpperCase();
    if (!name) { $('home-error').textContent = 'Enter your name first'; return; }
    if (code.length !== 4) { $('home-error').textContent = 'Enter the 4-letter room code'; return; }
    $('home-error').textContent = '';
    socket.emit('joinRoom', { code, name, playerId: myPlayerId }, (res) => {
      if (!res?.ok) { $('home-error').textContent = res?.error || 'Failed to join'; return; }
      currentRoom = res.code;
      myPlayerId = res.playerId;
      localStorage.setItem('flip7_pid', myPlayerId);
      history.replaceState(null, '', '#' + currentRoom);
    });
  });

  // ---------- Room wiring ----------
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-leave-game').addEventListener('click', () => {
    if (confirm('Leave the game? You can rejoin with the room code.')) leaveRoom();
  });
  function leaveRoom() {
    socket.emit('leaveRoom');
    currentRoom = null;
    state = null;
    history.replaceState(null, '', location.pathname);
    render();
  }

  $('btn-share').addEventListener('click', async () => {
    const url = location.origin + '/#' + currentRoom;
    const text = `Join my Flip 7 game!\nCode: ${currentRoom}\n${url}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Flip 7', text, url }); return; } catch {}
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied!');
    } catch {
      toast(currentRoom);
    }
  });
  $('room-code-wrap').addEventListener('click', async () => {
    if (!currentRoom) return;
    try { await navigator.clipboard.writeText(currentRoom); toast('Code copied'); } catch {}
  });

  $('btn-start').addEventListener('click', () => {
    socket.emit('startGame', null, (r) => { if (!r?.ok) toast(r?.error || 'Cannot start'); });
  });

  $('btn-next-round').addEventListener('click', () => {
    socket.emit('nextRound', null, (r) => { if (!r?.ok) toast(r?.error || 'Failed'); });
  });

  $('btn-new-game').addEventListener('click', () => {
    socket.emit('newGame', null, (r) => { if (!r?.ok) toast(r?.error || 'Failed'); });
  });

  $('btn-back-home').addEventListener('click', leaveRoom);

  // ---------- Socket events ----------
  socket.on('state', (s) => {
    state = s;
    render();
    handleEvent(s.lastEvent);
  });

  socket.on('connect', () => {
    // Auto-rejoin if we have a room hash and a stored playerId
    const hashCode = location.hash.replace('#', '').toUpperCase();
    if (hashCode && hashCode.length === 4 && myPlayerId && myName && !currentRoom) {
      socket.emit('joinRoom', { code: hashCode, name: myName, playerId: myPlayerId }, (res) => {
        if (res?.ok) {
          currentRoom = res.code;
          myPlayerId = res.playerId;
        }
      });
    }
  });

  socket.on('disconnect', () => toast('Disconnected — reconnecting…', 1500));

  // ---------- Initial render ----------
  // Pre-fill code from URL hash for join
  const hashCode = location.hash.replace('#', '').toUpperCase();
  if (hashCode && hashCode.length === 4) {
    $('code-input').value = hashCode;
  }
  render();
})();
