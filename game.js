import { randomUUID } from 'node:crypto';

export const NUMBER_COUNTS = { 0: 1, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 12 };
export const ACTION_TYPES = ['freeze', 'flip3', 'second_chance'];
export const PLUS_VALUES = [2, 4, 6, 8, 10];
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;

export function buildDeck() {
  const cards = [];
  for (const [n, count] of Object.entries(NUMBER_COUNTS)) {
    for (let i = 0; i < count; i++) {
      cards.push({ id: randomUUID(), kind: 'number', value: Number(n) });
    }
  }
  for (const action of ACTION_TYPES) {
    for (let i = 0; i < 3; i++) {
      cards.push({ id: randomUUID(), kind: 'action', action });
    }
  }
  for (const v of PLUS_VALUES) {
    cards.push({ id: randomUUID(), kind: 'modifier', mod: 'plus', value: v });
  }
  cards.push({ id: randomUUID(), kind: 'modifier', mod: 'x2' });
  return cards;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function laneScore(lane) {
  if (lane.status === 'busted') return 0;
  let base = lane.numbers.reduce((s, n) => s + n, 0);
  const hasX2 = lane.modifiers.some(m => m.mod === 'x2');
  if (hasX2) base *= 2;
  const plus = lane.modifiers.filter(m => m.mod === 'plus').reduce((s, m) => s + m.value, 0);
  let total = base + plus;
  if (lane.status === 'flip7') total += 15;
  return total;
}

export class Game {
  constructor({ targetScore = 200 } = {}) {
    this.targetScore = targetScore;
    this.players = [];
    this.phase = 'lobby';
    this.deck = [];
    this.discard = [];
    this.round = 0;
    this.startingPlayerIdx = 0;
    this.lanes = {};
    this.turnStack = [];
    this.pendingAction = null;
    this.lastEvent = null;
    this.eventSeq = 0;
    this.winnerIds = [];
    this.lastRoundSummary = null;
  }

  // ---------- Player management ----------
  addPlayer({ id, name }) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    if (this.players.length >= MAX_PLAYERS) throw new Error('Room is full');
    const cleanName = String(name || '').trim().slice(0, 16);
    if (!cleanName) throw new Error('Name required');
    if (this.players.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('Name taken');
    }
    this.players.push({ id, name: cleanName, totalScore: 0, connected: true, isHost: this.players.length === 0 });
  }

  removePlayer(id) {
    if (this.phase === 'lobby') {
      const wasHost = this.players.find(p => p.id === id)?.isHost;
      this.players = this.players.filter(p => p.id !== id);
      if (wasHost && this.players.length > 0) this.players[0].isHost = true;
    } else {
      const p = this.players.find(p => p.id === id);
      if (p) p.connected = false;
    }
  }

  reconnectPlayer(id) {
    const p = this.players.find(p => p.id === id);
    if (p) {
      p.connected = true;
      return true;
    }
    return false;
  }

  // ---------- Round lifecycle ----------
  startGame(byId) {
    if (this.phase !== 'lobby') throw new Error('Already started');
    if (this.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
    const host = this.players.find(p => p.isHost);
    if (host && host.id !== byId) throw new Error('Only host can start');
    this.startRound();
  }

  startRound() {
    this.round++;
    this.deck = shuffle(buildDeck());
    this.discard = [];
    this.lanes = {};
    for (const p of this.players) {
      this.lanes[p.id] = {
        numbers: [],
        modifiers: [],
        hasSecondChance: false,
        status: 'active',
      };
    }
    this.turnStack = [{ type: 'turn', playerId: this.players[this.startingPlayerIdx].id }];
    this._lastTurnPlayerIdx = this.startingPlayerIdx;
    this.pendingAction = null;
    this.phase = 'playing';
    this.lastRoundSummary = null;
    this._emit({ type: 'roundStart', round: this.round });
  }

  startNextRound(byId) {
    if (this.phase !== 'roundEnd') throw new Error('Round not over');
    const host = this.players.find(p => p.isHost);
    if (host && host.id !== byId) throw new Error('Only host can advance');
    this.startingPlayerIdx = (this.startingPlayerIdx + 1) % this.players.length;
    this.startRound();
  }

  newGame(byId) {
    if (this.phase !== 'gameOver') throw new Error('Game not over');
    const host = this.players.find(p => p.isHost);
    if (host && host.id !== byId) throw new Error('Only host can restart');
    for (const p of this.players) p.totalScore = 0;
    this.round = 0;
    this.startingPlayerIdx = 0;
    this.winnerIds = [];
    this.phase = 'lobby';
    this._emit({ type: 'newGame' });
  }

  // ---------- Drawing ----------
  drawFromDeck() {
    if (this.deck.length === 0) {
      if (this.discard.length === 0) return null;
      this.deck = shuffle(this.discard);
      this.discard = [];
    }
    return this.deck.pop();
  }

  get activeFrame() {
    return this.turnStack[this.turnStack.length - 1] || null;
  }

  get activePlayerId() {
    return this.activeFrame?.playerId || null;
  }

  hit(playerId) {
    if (this.phase !== 'playing') throw new Error('Not in play');
    if (this.pendingAction) throw new Error('Resolve pending action first');
    if (this.activePlayerId !== playerId) throw new Error('Not your turn');
    const card = this.drawFromDeck();
    if (!card) throw new Error('No cards left');
    this._applyDraw(playerId, card);
    this._cleanupAndAdvance();
  }

  stay(playerId) {
    if (this.phase !== 'playing') throw new Error('Not in play');
    if (this.pendingAction) throw new Error('Resolve pending action first');
    if (this.activePlayerId !== playerId) throw new Error('Not your turn');
    if (this.activeFrame.type === 'forcedDraws') throw new Error('Must complete forced draws');
    this.lanes[playerId].status = 'stayed';
    this._emit({ type: 'stay', playerId });
    // pop their turn frame
    this.turnStack.pop();
    this._cleanupAndAdvance();
  }

  chooseTarget(playerId, targetId) {
    if (!this.pendingAction) throw new Error('No pending action');
    if (this.pendingAction.byPlayerId !== playerId) throw new Error('Not your choice');
    const targetLane = this.lanes[targetId];
    if (!targetLane) throw new Error('Invalid target');
    if (targetLane.status !== 'active') throw new Error('Target not active');

    const action = this.pendingAction.type;
    const card = this.pendingAction.card;

    if (action === 'second_chance') {
      if (targetId === playerId) throw new Error('Cannot give SC to self');
      if (targetLane.hasSecondChance) throw new Error('Target already has Second Chance');
    }

    this.pendingAction = null;

    if (action === 'freeze') {
      this.discard.push(card);
      targetLane.status = 'frozen';
      this._emit({ type: 'freeze', byPlayerId: playerId, targetId });
      // Decrement drawer's forced-draws counter (the freeze counted as a draw)
      this._consumeForcedDraw(playerId);
      // Remove any frames belonging to the frozen target
      this.turnStack = this.turnStack.filter(f => f.playerId !== targetId);
    } else if (action === 'flip3') {
      this.discard.push(card);
      this._emit({ type: 'flip3', byPlayerId: playerId, targetId });
      // Decrement drawer's forced-draws counter first (flip3 was their draw)
      this._consumeForcedDraw(playerId);
      // Then push target's forced-draws frame on top
      this.turnStack.push({ type: 'forcedDraws', playerId: targetId, remaining: 3 });
    } else if (action === 'second_chance') {
      this.discard.push(card);
      targetLane.hasSecondChance = true;
      this._emit({ type: 'secondChanceGifted', byPlayerId: playerId, targetId });
      this._consumeForcedDraw(playerId);
    }

    this._cleanupAndAdvance();
  }

  // ---------- Internals ----------
  _applyDraw(playerId, card) {
    const lane = this.lanes[playerId];
    this._emit({ type: 'draw', playerId, card });

    if (card.kind === 'number') {
      if (lane.numbers.includes(card.value)) {
        if (lane.hasSecondChance) {
          lane.hasSecondChance = false;
          this.discard.push(card);
          // also discard a virtual SC card representation
          this.discard.push({ id: randomUUID(), kind: 'action', action: 'second_chance' });
          this._emit({ type: 'secondChanceUsed', playerId, value: card.value });
          this._consumeForcedDraw(playerId);
          return;
        }
        // BUST
        lane.status = 'busted';
        this.discard.push(card);
        this._emit({ type: 'bust', playerId, value: card.value });
        // remove all frames belonging to this player
        this.turnStack = this.turnStack.filter(f => f.playerId !== playerId);
        return;
      }
      lane.numbers.push(card.value);
      if (lane.numbers.length === 7) {
        lane.status = 'flip7';
        this._emit({ type: 'flip7', playerId });
        // round will end immediately via _cleanupAndAdvance
        return;
      }
      this._consumeForcedDraw(playerId);
      return;
    }

    if (card.kind === 'modifier') {
      lane.modifiers.push(card);
      this._consumeForcedDraw(playerId);
      return;
    }

    if (card.kind === 'action') {
      if (card.action === 'second_chance') {
        if (!lane.hasSecondChance) {
          lane.hasSecondChance = true;
          this._emit({ type: 'gainSecondChance', playerId });
          this._consumeForcedDraw(playerId);
          return;
        }
        const eligible = this.players.filter(p =>
          p.id !== playerId &&
          this.lanes[p.id].status === 'active' &&
          !this.lanes[p.id].hasSecondChance
        );
        if (eligible.length === 0) {
          this.discard.push(card);
          this._emit({ type: 'secondChanceDiscarded', playerId });
          this._consumeForcedDraw(playerId);
          return;
        }
        this.pendingAction = { type: 'second_chance', byPlayerId: playerId, card };
        return;
      }
      // freeze / flip3: wait for target choice
      this.pendingAction = { type: card.action, byPlayerId: playerId, card };
      return;
    }
  }

  _consumeForcedDraw(playerId) {
    const frame = this.activeFrame;
    if (!frame) return;
    if (frame.type === 'forcedDraws' && frame.playerId === playerId) {
      frame.remaining--;
      if (frame.remaining <= 0) {
        this.turnStack.pop();
      }
    }
  }

  _cleanupAndAdvance() {
    // Round ends if anyone hit Flip 7
    if (Object.values(this.lanes).some(l => l.status === 'flip7')) {
      this._endRound();
      return;
    }
    if (this.pendingAction) return;

    // Pop frames whose owner is no longer active
    while (this.turnStack.length) {
      const top = this.turnStack[this.turnStack.length - 1];
      if (this.lanes[top.playerId].status !== 'active') {
        this.turnStack.pop();
      } else break;
    }

    if (this.turnStack.length > 0) return; // still someone's turn

    // Need to find the next active player after the most recent player to act
    const last = this._lastTurnPlayerIdx ?? this.startingPlayerIdx;
    const next = this._findNextActivePlayerAfter(last);
    if (!next) {
      this._endRound();
      return;
    }
    this._lastTurnPlayerIdx = this.players.findIndex(p => p.id === next.id);
    this.turnStack.push({ type: 'turn', playerId: next.id });
  }

  _findNextActivePlayerAfter(startIdx) {
    for (let i = 1; i <= this.players.length; i++) {
      const p = this.players[(startIdx + i) % this.players.length];
      if (this.lanes[p.id].status === 'active') return p;
    }
    return null;
  }

  _endRound() {
    const summary = [];
    for (const p of this.players) {
      const lane = this.lanes[p.id];
      const score = laneScore(lane);
      p.totalScore += score;
      summary.push({
        playerId: p.id,
        name: p.name,
        roundScore: score,
        totalScore: p.totalScore,
        status: lane.status,
        numbers: [...lane.numbers],
        modifiers: lane.modifiers.map(m => ({ ...m })),
      });
    }
    this.lastRoundSummary = summary;
    this._emit({ type: 'roundEnd', summary });

    // Check for game over
    const max = Math.max(...this.players.map(p => p.totalScore));
    if (max >= this.targetScore) {
      const top = this.players.filter(p => p.totalScore === max);
      if (top.length === 1) {
        this.winnerIds = [top[0].id];
        this.phase = 'gameOver';
        this._emit({ type: 'gameOver', winnerIds: this.winnerIds });
        return;
      }
      // tie at the top — play another round
    }
    this.phase = 'roundEnd';
  }

  _emit(event) {
    this.eventSeq++;
    this.lastEvent = { ...event, seq: this.eventSeq };
  }

  // ---------- Snapshot for clients ----------
  snapshot() {
    return {
      phase: this.phase,
      round: this.round,
      targetScore: this.targetScore,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        totalScore: p.totalScore,
        connected: p.connected,
        isHost: p.isHost,
      })),
      lanes: Object.fromEntries(Object.entries(this.lanes).map(([id, l]) => [id, {
        numbers: [...l.numbers],
        modifiers: l.modifiers.map(m => ({ ...m })),
        hasSecondChance: l.hasSecondChance,
        status: l.status,
        roundScore: laneScore(l),
      }])),
      activePlayerId: this.activePlayerId,
      activeFrame: this.activeFrame ? { type: this.activeFrame.type, remaining: this.activeFrame.remaining } : null,
      pendingAction: this.pendingAction ? {
        type: this.pendingAction.type,
        byPlayerId: this.pendingAction.byPlayerId,
      } : null,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discardTop: this.discard[this.discard.length - 1] || null,
      lastEvent: this.lastEvent,
      winnerIds: this.winnerIds,
      lastRoundSummary: this.lastRoundSummary,
    };
  }
}
