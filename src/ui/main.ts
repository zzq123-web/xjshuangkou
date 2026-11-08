import { classifyBid } from '../game/bid.js';
import { createDeck, dealHands, shuffleCards } from '../game/deck.js';
import { callPartner, canRespondToBid, createGameState, exchangeBidCards, passBid, playTurn, recordBid, resolveBidding, revealedBids } from '../game/engine.js';
import { sortHandForDisplay } from '../game/trump.js';
import { beginTributePhase, chooseTributeCards, preservesEverySuit, splitTeamQuota, supplyCount, teamCanAntiSupply } from '../game/tribute.js';
import { chooseBotBid, chooseBotCalledCard, chooseBotExchange, chooseBotPlay } from './bot.js';
import type { Card, GameState, PlayerId } from '../game/types.js';

const SUITS = {
  clubs: { name: '梅花', symbol: '♣', red: false },
  spades: { name: '黑桃', symbol: '♠', red: false },
  hearts: { name: '红桃', symbol: '♥', red: true },
  diamonds: { name: '方片', symbol: '♦', red: true }
} as const;
const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('App container is missing.');
const app: HTMLDivElement = appElement;

interface RoomIdentity {
  readonly code: string;
  readonly token: string;
  readonly playerId: PlayerId;
}

interface RoomPlayerView {
  readonly id: PlayerId;
  readonly name: string;
  readonly ready: boolean;
}

interface RoomSnapshot {
  readonly code: string;
  readonly hostId: PlayerId;
  readonly playerId: PlayerId;
  readonly inviteUrl: string;
  readonly status: 'waiting' | 'playing' | 'finished';
  readonly version: number;
  readonly players: readonly RoomPlayerView[];
  readonly game: GameState | null;
  readonly message: string;
  readonly history: readonly string[];
}

class RoomRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'RoomRequestError';
  }
}

function loadRoomIdentity(): RoomIdentity | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('shuangkou-room') ?? 'null');
    if (typeof raw !== 'object' || raw === null) return null;
    const data = raw as Record<string, unknown>;
    if (typeof data.code !== 'string' || typeof data.token !== 'string' || typeof data.playerId !== 'number') return null;
    if (![0, 1, 2, 3].includes(data.playerId)) return null;
    return { code: data.code, token: data.token, playerId: data.playerId as PlayerId };
  } catch {
    return null;
  }
}

function initialRoomCode(): string {
  return new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() ?? '';
}

let state = createGameState(deal(), 0);
let selected: string[] = [];
const requestedRoomCode = initialRoomCode();
const storedRoom = loadRoomIdentity();
let room = requestedRoomCode && storedRoom?.code !== requestedRoomCode ? null : storedRoom;
let roomSnapshot: RoomSnapshot | null = null;
let roomPollTimer: number | null = null;
let roomRequestPending = false;
let needsPass = false;
let needsSetup = room === null;
let showNameEditor = false;
let humanCount = room ? 4 : 1;
let draftHumanCount = 1;
let humanNames = ['玩家1', '玩家2', '玩家3', '玩家4'];
let draftNames = [...humanNames];
let lastHumanPlayer: PlayerId | null = null;
let botTimer: number | null = null;
let biddingViewer: PlayerId = 0;
const bidBotTimers = new Map<PlayerId, number>();
let roomFormMode: 'create' | 'join' | null = initialRoomCode() ? 'join' : null;
let roomCodeInput = initialRoomCode();
let roomNameInput = '玩家';
let modalError = '';
let notice = '选择真人玩家数量，开始游戏。';
let history: string[] = [];

function deal(): ReturnType<typeof dealHands> {
  return dealHands(shuffleCards(createDeck(), randomValues(107)));
}

function randomValues(count: number): number[] {
  const values = new Uint32Array(count);
  crypto.getRandomValues(values);
  return Array.from(values, value => value / 0x1_0000_0000);
}

function shuffleArray<T>(items: readonly T[]): T[] {
  const shuffled = [...items];
  const values = randomValues(Math.max(0, shuffled.length - 1));
  for (let index = shuffled.length - 1, step = 0; index > 0; index -= 1, step += 1) {
    const swapIndex = Math.floor(values[step] * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

interface RoomRequestBody {
  readonly name?: string;
  readonly action?: string;
  readonly cardIds?: readonly string[];
}

async function roomRequest<T>(path: string, body?: RoomRequestBody, token: string | null | undefined = room?.token): Promise<T> {
  const headers = new Headers();
  if (body) headers.set('content-type', 'application/json');
  if (token) headers.set('x-room-token', token);
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const result: unknown = await response.json();
  if (!response.ok) {
    const errorMessage = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
      ? result.error
      : '房间请求失败。';
    throw new RoomRequestError(response.status, errorMessage);
  }
  return result as T;
}

function saveRoomIdentity(identity: RoomIdentity | null): void {
  if (!identity) {
    localStorage.removeItem('shuangkou-room');
    return;
  }
  localStorage.setItem('shuangkou-room', JSON.stringify(identity));
}

function applyRoomSnapshot(snapshot: RoomSnapshot, force = false): void {
  if (roomSnapshot && snapshot.version < roomSnapshot.version) return;
  if (!force && roomSnapshot?.version === snapshot.version) return;
  const preserveSelection = !force && room !== null && roomSnapshot?.game?.phase === 'bidding'
    && snapshot.game !== null && canRespondToBid(snapshot.game, room.playerId);
  roomSnapshot = snapshot;
  history = [...snapshot.history];
  notice = snapshot.message;
  needsPass = false;
  if (!preserveSelection) selected = [];
  if (snapshot.game) {
    state = snapshot.game;
    humanNames = snapshot.players.map(player => player.name);
    draftNames = [...humanNames];
  }
  render();
}

function startRoomPolling(): void {
  if (roomPollTimer !== null) window.clearTimeout(roomPollTimer);
  roomPollTimer = null;
  if (room) void pollRoom();
}

async function pollRoom(): Promise<void> {
  const identity = room;
  if (!identity) return;
  try {
    const snapshot = await roomRequest<RoomSnapshot>(`/api/rooms/${identity.code}`, undefined, identity.token);
    if (room === identity) applyRoomSnapshot(snapshot);
  } catch (error) {
    if (room === identity) {
      if (error instanceof RoomRequestError && (error.statusCode === 401 || error.statusCode === 404)) {
        room = null;
        roomSnapshot = null;
        saveRoomIdentity(null);
        needsSetup = true;
        roomFormMode = 'join';
        roomCodeInput = identity.code;
        roomNameInput = humanNames[identity.playerId]?.trim() || '玩家';
        modalError = '这个房间已失效，请重新创建房间或加入其他房间。';
        render();
        return;
      }
      notice = error instanceof Error ? error.message : '房间连接中断。';
      render();
    }
  } finally {
    if (room === identity) roomPollTimer = window.setTimeout(() => void pollRoom(), 900);
  }
}

function saveRoomAndEnter(identity: RoomIdentity, snapshot: RoomSnapshot): void {
  room = identity;
  saveRoomIdentity(identity);
  needsSetup = false;
  needsPass = false;
  showNameEditor = false;
  humanCount = 4;
  applyRoomSnapshot(snapshot, true);
  startRoomPolling();
}

async function createRoom(): Promise<void> {
  const response = await roomRequest<{ readonly token: string; readonly playerId: PlayerId; readonly snapshot: RoomSnapshot }>(
    '/api/rooms', { name: roomNameInput }, null
  );
  saveRoomAndEnter({ code: response.snapshot.code, token: response.token, playerId: response.playerId }, response.snapshot);
}

async function joinRoom(): Promise<void> {
  const code = roomCodeInput.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('请输入6位房间号。');
  const response = await roomRequest<{ readonly token: string; readonly playerId: PlayerId; readonly snapshot: RoomSnapshot }>(
    `/api/rooms/${code}/join`, { name: roomNameInput }, null
  );
  saveRoomAndEnter({ code, token: response.token, playerId: response.playerId }, response.snapshot);
}

async function submitRoomAction(action: string): Promise<void> {
  if (!room || roomRequestPending) return;
  roomRequestPending = true;
  render();
  try {
    const cardIds = action === 'pass' ? [] : selectedCards().map(card => card.id);
    const snapshot = await roomRequest<RoomSnapshot>(`/api/rooms/${room.code}/action`, { action, cardIds });
    applyRoomSnapshot(snapshot, true);
  } catch (error) {
    notice = error instanceof Error ? error.message : '操作失败。';
    render();
  } finally {
    roomRequestPending = false;
    render();
  }
}

function escapeHtml(value: string): string {
  const replacements: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, character => replacements[character] ?? character);
}
function isHumanPlayer(id: PlayerId): boolean { return room !== null || id < humanCount; }
function playerName(id: PlayerId): string {
  if (room && roomSnapshot) return roomSnapshot.players[id]?.name ?? `玩家${id + 1}`;
  if (isHumanPlayer(id)) return humanNames[id].trim() || `玩家${id + 1}`;
  return `人机${id - humanCount + 1}`;
}
function face(card: Card): string {
  if (card.rank === 'BJ') return '大王';
  if (card.rank === 'SJ') return '小王';
  return `${SUITS[card.suit as keyof typeof SUITS].name}${card.rank}`;
}
function shortFace(card: Card): string {
  if (card.rank === 'BJ') return '大王';
  if (card.rank === 'SJ') return '小王';
  return `${SUITS[card.suit as keyof typeof SUITS].symbol}${card.rank}`;
}
function faceColor(card: Card): string {
  return card.suit === 'joker' || SUITS[card.suit as keyof typeof SUITS]?.red ? 'red' : '';
}
function pointsFor(card: Card): number {
  return card.rank === '5' ? 5 : card.rank === '10' || card.rank === 'K' ? 10 : 0;
}
function activePlayer(): PlayerId {
  if (state.phase === 'bidding') return room?.playerId ?? state.forcedBidder ?? biddingViewer;
  return state.currentPlayer;
}
function currentHand(): readonly Card[] { return state.players[activePlayer()].hand; }
function isBotTurn(): boolean { return !isHumanPlayer(activePlayer()); }

function bidLabel(cards: readonly Card[]): string {
  const shape = classifyBid(cards);
  if (!shape) return '无效叫牌';
  if (shape.kind === 'pair') return `对子 ${face(cards[0])}`;
  return `${shape.cardCount}张拖拉机 ${SUITS[cards[0].suit as keyof typeof SUITS].name} ${cards[0].rank}起`;
}

function seatClass(id: PlayerId, viewer: PlayerId): string {
  const relative = (id - viewer + 4) % 4;
  return ['seat-bottom', 'seat-right', 'seat-top', 'seat-left'][relative];
}
function teamLabel(id: PlayerId): string {
  if (state.dealer === null || state.partner === null) return '';
  return id === state.dealer || id === state.partner ? '庄家队' : '闲家队';
}
function seatHtml(id: PlayerId, viewer: PlayerId): string {
  const player = state.players[id];
  const isCurrent = state.phase === 'bidding' ? canRespondToBid(state, id)
    : id === activePlayer() && !['round-end', 'dealing', 'tribute'].includes(state.phase);
  const isDealer = id === state.dealer;
  const privateRole = !needsPass && id === viewer && id === state.partner && state.phase !== 'round-end' ? '你是队友' : '';
  const revealedRole = state.phase === 'round-end' ? teamLabel(id) : '';
  const backs = Array.from({ length: Math.min(player.hand.length, 8) }, () => '<span class="back"></span>').join('');
  return `<section class="seat ${seatClass(id, viewer)} ${isCurrent ? 'current' : ''} ${isDealer ? 'dealer' : ''}">
    <div><span class="seatName">${escapeHtml(playerName(id))}</span>${isDealer ? '<small class="seatRole">庄家</small>' : ''}${privateRole ? `<small class="seatRole">${privateRole}</small>` : ''}${revealedRole ? `<small class="seatRole">${revealedRole}</small>` : ''}</div>
    <div class="seatMeta"><span>${state.phase === 'round-end' ? teamLabel(id) : '手牌'}</span><span>${player.hand.length}张</span></div>
    <div class="backs">${backs}<span class="backCount">×${player.hand.length}</span></div>
  </section>`;
}
function playedCardHtml(card: Card): string {
  if (card.suit === 'joker') return `<span class="tinyCard red"><span>${face(card)}</span><span class="tinySuit">★</span></span>`;
  const suit = SUITS[card.suit];
  return `<span class="tinyCard ${suit.red ? 'red' : ''}"><span>${card.rank}</span><span class="tinySuit">${suit.symbol}</span></span>`;
}
function handCardHtml(card: Card): string {
  const isSelected = selected.includes(card.id);
  const color = faceColor(card);
  if (card.suit === 'joker') {
    return `<button class="card ${color} ${isSelected ? 'selected' : ''}" data-card="${card.id}" aria-label="${face(card)}"><span class="jokerText">${face(card)}</span><span class="symbol">${card.rank === 'BJ' ? '★' : '☆'}</span></button>`;
  }
  const suit = SUITS[card.suit];
  return `<button class="card ${color} ${isSelected ? 'selected' : ''}" data-card="${card.id}" aria-label="${face(card)}"><span class="rank">${card.rank}</span><span class="symbol">${suit.symbol}</span></button>`;
}
function trickHtml(): string {
  if (!state.currentTrick.length) return '<span class="empty">等待首家领牌</span>';
  return state.currentTrick.map(play => `<div class="played"><span class="playedName">${escapeHtml(playerName(play.player))}</span><div class="playedCards">${play.cards.map(playedCardHtml).join('')}</div></div>`).join('');
}
function stageLabel(): string {
  const labels: Record<GameState['phase'], string> = {
    dealing: '重新发牌', bidding: '抢庄', exchange: '庄家换牌', 'partner-call': '叫队友', play: `第${state.trickCount + 1}墩`, 'round-end': '本局结算', tribute: '上供还牌'
  };
  return labels[state.phase];
}
function actionButtons(): string {
  if (state.phase === 'dealing') return !room || room.playerId === roomSnapshot?.hostId ? '<button class="btn primary" data-action="redeal">重新发牌</button>' : '';
  if (state.phase === 'round-end') return roomRequestPending ? '' : !room || room.playerId === roomSnapshot?.hostId
    ? '<button class="btn primary" data-action="next">开始上供</button>'
    : '<span class="roomHint">等待房主开始上供…</span>';
  if (state.phase === 'tribute') return roomRequestPending ? '' : !room || room.playerId === roomSnapshot?.hostId
    ? `<button class="btn primary" data-action="continue-next">${state.tributeExchanges.length ? '上供还牌完成，开始下一局' : '无需上供，开始下一局'}</button>`
    : '<span class="roomHint">等待房主确认上供结果…</span>';
  if (state.phase === 'bidding') {
    if (roomRequestPending || needsPass || isBotTurn()) return '';
    const player = activePlayer();
    const switchers = !room && humanCount > 1 && state.forcedBidder === null
      ? `<div class="controls">${([0, 1, 2, 3] as const).filter(id => id < humanCount && id !== player && canRespondToBid(state, id)).map(id => `<button class="btn" data-bid-viewer="${id}">交给${escapeHtml(playerName(id))}抢叫</button>`).join('')}</div>` : '';
    if (!canRespondToBid(state, player)) return `<span class="roomHint">已完成选择，等待其他玩家…</span>${switchers}`;
    return `<button class="btn primary" data-action="bid">${state.forcedBidder !== null ? '强制叫庄' : '抢叫庄'}</button>${state.forcedBidder === null ? '<button class="btn" data-action="pass">不争</button>' : ''}<button class="btn" data-action="clear">清除选牌</button>${switchers}`;
  }
  if (room && (roomRequestPending || room.playerId !== state.currentPlayer)) return '';
  if (isBotTurn() || needsPass) return '';
  if (state.phase === 'exchange') return `<button class="btn primary" data-action="exchange">确认还牌（${state.bids.find(bid => bid.player === state.pendingExchange[0])?.cardCount ?? 0}张）</button><button class="btn" data-action="clear">清除选牌</button>`;
  if (state.phase === 'partner-call') return '<button class="btn primary" data-action="call">确认叫队友</button><button class="btn" data-action="clear">清除选牌</button>';
  if (state.phase === 'play') return '<button class="btn primary" data-action="play">出牌</button><button class="btn" data-action="clear">清除选牌</button>';
  return '';
}
function instruction(): string {
  if (state.phase === 'tribute') return state.tributeExchanges.length
    ? '上供牌和还牌已处理，请查看明细后开始下一局。'
    : '本轮没有发生上供，请确认后开始下一局。';
  if (state.phase === 'bidding') {
    return state.forcedBidder !== null
      ? `四家均未叫庄，由${playerName(state.forcedBidder)}强制叫庄。`
      : state.fullSupply && state.bidRequirement === null && !state.previousLosingTeam?.includes(activePlayer())
        ? '满供规则：上一局赢家需要等输家先叫庄，之后可以参与叫庄。'
      : `${bidRequirementLabel()}无需按座位等待，牌的点数不必更大；四家选择完成后统一比大小定庄。`;
  }
  if (state.phase === 'exchange') return `庄家收下${playerName(state.pendingExchange[0])}的争庄牌，选择等量牌还给对方。`;
  if (state.phase === 'partner-call') return '选择自己持有的一张副牌叫队友；不能叫主花色、2、3、5或大小王。';
  if (state.phase === 'play') return state.lead
    ? `首家出了 ${state.lead.cards.map(shortFace).join(' ')}。必须先跟首家副花色或主牌；没有时才能垫牌。`
    : `${playerName(activePlayer())}领牌：可出单张、对子或4/6张拖拉机。`;
  if (state.phase === 'dealing') return '四家都没有有效叫庄牌，按规则重新发牌。';
  const winner = state.winnerTeam === null ? '双方平分' : state.winnerTeam === 0 ? '庄家队获胜' : '闲家队获胜';
  return `本局结束：${winner}。当前总分 ${state.scores[0]} : ${state.scores[1]}。`;
}
function bidStatusHtml(): string {
  if (!state.bidsRevealed) return `<div class="bidStatus">${bidRequirementLabel()}<br>${state.bidTurn}/4名玩家已完成选择；牌面封存，全部完成后统一揭晓。<br>${([0, 1, 2, 3] as const).map(id => `${escapeHtml(playerName(id))}：${state.bidResponded.includes(id) ? '已选择' : '待选择'}`).join(' · ')}</div>`;
  if (!state.bids.length) return '<div class="bidStatus">本局没有有效叫庄牌。</div>';
  return `<div class="bidStatus">${revealedBids(state).map(bid => `<div class="bidLine"><b>${escapeHtml(playerName(bid.player))}</b>：${bidLabel(bid.cards)} · ${bid.cards.map(card => `<span class="${faceColor(card)}">${shortFace(card)}</span>`).join(' ')}</div>`).join('')}</div>`;
}
function bidRequirementLabel(): string {
  const requirement = state.bidRequirement;
  if (!requirement) return '自由抢叫，首个有效叫牌锁定牌型和张数。';
  return requirement.kind === 'pair' ? '本轮已锁定对子（2张）。' : `本轮已锁定${requirement.cardCount}张拖拉机。`;
}
function tributeSummaryHtml(): string {
  if (!state.tributeExchanges.length) return '<div class="bidStatus">本轮不上供，确认后即可开始下一局。</div>';
  return `<div class="tributeList">${state.tributeExchanges.map(exchange => `<div class="tributeLine"><b>${escapeHtml(playerName(exchange.from))} → ${escapeHtml(playerName(exchange.to))} · 上供</b><div class="tributeCards">${exchange.offered.map(playedCardHtml).join(' ')}</div><small>${escapeHtml(playerName(exchange.to))} → ${escapeHtml(playerName(exchange.from))} · 还牌</small><div class="tributeCards">${exchange.returned.map(playedCardHtml).join(' ')}</div></div>`).join('')}</div>`;
}
function overlayHtml(): string {
  if (needsSetup && roomFormMode) {
    const joining = roomFormMode === 'join';
    return `<div class="overlay"><div class="dialog setupDialog"><div class="dialogMark">♣</div><span class="eyebrow">ROOM PLAY</span><h2>${joining ? '加入房间' : '创建联网房'}</h2><p>${joining ? '输入房间号和昵称，加入四人牌局。' : '创建房间后，把房间号或邀请链接发给另外三位玩家。'}</p>${joining ? `<label class="nameField"><span>房间号</span><input maxlength="6" data-room-code value="${escapeHtml(roomCodeInput)}" placeholder="例如 A2BC34"></label>` : ''}<label class="nameField"><span>你的昵称</span><input maxlength="16" data-room-name value="${escapeHtml(roomNameInput)}" placeholder="玩家"></label>${modalError ? `<p class="formError">${escapeHtml(modalError)}</p>` : ''}<div class="dialogActions"><button class="btn primary" data-action="${joining ? 'submit-room-join' : 'submit-room-create'}">${joining ? '加入房间' : '创建房间'}</button><button class="btn" data-action="back-to-setup">返回</button></div></div></div>`;
  }
  if (needsSetup) {
    const counts = [1, 2, 3, 4].map(count => `<button class="modeChoice ${draftHumanCount === count ? 'active' : ''}" data-count="${count}">${count}人</button>`).join('');
    const names = Array.from({ length: draftHumanCount }, (_, index) => `<label class="nameField"><span>玩家${index + 1}昵称</span><input maxlength="16" data-draft-name="${index}" value="${escapeHtml(draftNames[index])}" placeholder="玩家${index + 1}"></label>`).join('');
    return `<div class="overlay"><div class="dialog setupDialog"><div class="dialogMark">♣</div><span class="eyebrow">XINJIANG SHUANGKOU</span><h2>开始一局</h2><p>选择真人玩家人数，其余座位由人机补齐。</p><div class="modeChoices">${counts}</div><div class="nameFields">${names}</div><div class="dialogActions"><button class="btn primary" data-action="start-local">开始游戏</button><button class="btn" data-action="create-room">创建联网房</button><button class="btn" data-action="join-room">加入房间</button></div></div></div>`;
  }
  if (showNameEditor) {
    const names = room
      ? `<label class="nameField"><span>你的昵称</span><input maxlength="16" data-edit-name="${room.playerId}" value="${escapeHtml(draftNames[room.playerId])}" placeholder="玩家"></label>`
      : Array.from({ length: humanCount }, (_, index) => `<label class="nameField"><span>玩家${index + 1}昵称</span><input maxlength="16" data-edit-name="${index}" value="${escapeHtml(draftNames[index])}" placeholder="玩家${index + 1}"></label>`).join('');
    return `<div class="overlay"><div class="dialog setupDialog"><h2>修改玩家昵称</h2><p>人机名称按座位自动编号。</p><div class="nameFields">${names}</div>${modalError ? `<p class="formError">${escapeHtml(modalError)}</p>` : ''}<div class="dialogActions"><button class="btn primary" data-action="save-names">保存昵称</button><button class="btn" data-action="cancel-names">取消</button></div></div></div>`;
  }
  if (room || !needsPass || ['dealing', 'round-end', 'tribute'].includes(state.phase)) return '';
  return `<div class="overlay"><div class="dialog"><h2>请交给${escapeHtml(playerName(activePlayer()))}</h2><p>轮到当前玩家查看手牌。请确认其他人看不到屏幕后继续。</p><button class="btn primary" data-action="reveal">我已接手</button></div></div>`;
}

function renderRoomLobby(): void {
  if (!room || !roomSnapshot) return;
  const hostId = roomSnapshot.hostId;
  const readyCount = roomSnapshot.players.filter(player => player.ready).length;
  const seats = roomSnapshot.players.map((player, index) => `<div class="roomSeat ${player.ready ? 'ready' : ''}"><div><b>${['东家', '南家', '西家', '北家'][index]}</b>${index === hostId ? '<small>房主</small>' : ''}</div><span>${escapeHtml(player.ready ? player.name : '等待加入')}</span></div>`).join('');
  const startButton = room.playerId === roomSnapshot.hostId
    ? `<button class="btn primary" data-action="start-room" ${readyCount < 4 ? 'disabled' : ''}>${readyCount < 4 ? `等待玩家加入（${readyCount}/4）` : '四人到齐，开始游戏'}</button>`
    : '<p class="roomHint">等待房主开始游戏…</p>';
  app.innerHTML = `<header><div class="brand"><div class="mark">♣</div><div><h1>新疆双扣</h1><div class="sub">四人联机房间</div></div></div><div class="top"><button class="btn" data-action="copy-room">复制邀请链接</button><button class="btn" data-action="edit-names">修改昵称</button><button class="btn" data-action="leave-room">离开房间</button></div></header><main class="roomLobby"><span class="eyebrow">ROOM LOBBY</span><h2>等待玩家加入</h2><p>把房间号或邀请链接发给同一局域网内的玩家。</p><div class="roomCode">${escapeHtml(roomSnapshot.code)}</div><label class="inviteField"><span>邀请链接</span><input readonly value="${escapeHtml(roomSnapshot.inviteUrl)}" aria-label="邀请链接"></label><div class="roomSeats">${seats}</div><div class="roomActions">${startButton}</div><p class="roomHint">房间 ${escapeHtml(roomSnapshot.code)} · 你是${room.playerId === roomSnapshot.hostId ? '房主' : `${room.playerId + 1}号玩家`}</p><p class="roomHint">${escapeHtml(notice || roomSnapshot.message)}</p></main>${overlayHtml()}`;
}
function render(): void {
  if (room) {
    if (!roomSnapshot) {
      app.innerHTML = `<main class="roomWait"><div class="dialogMark">♣</div><h1>正在连接房间</h1><p>${escapeHtml(notice || room.code)}</p></main>`;
      return;
    }
    if (!roomSnapshot.game) {
      renderRoomLobby();
      return;
    }
    state = roomSnapshot.game;
    humanCount = 4;
    humanNames = roomSnapshot.players.map(player => player.name);
  }
  const viewer = activePlayer();
  const suit = state.trumpSuit;
  const hand = sortHandForDisplay(room ? state.players[room.playerId].hand : currentHand(), suit);
  const handVisible = room
    ? !showNameEditor && !['dealing', 'round-end', 'tribute'].includes(state.phase)
    : !needsSetup && !showNameEditor && !needsPass && !isBotTurn() && !['dealing', 'round-end', 'tribute'].includes(state.phase);
  const trump = suit ? SUITS[suit] : null;
  const revealedPoints = state.currentTrick.flatMap(play => play.cards).reduce((sum, card) => sum + pointsFor(card), 0);
  const handTitle = state.phase === 'tribute'
    ? '上供还牌结果'
    : room && room.playerId !== viewer ? `我的手牌：${playerName(room.playerId)}` : `当前操作：${playerName(viewer)}`;
  const handStatus = state.phase === 'tribute'
    ? '手牌保密'
    : handVisible ? `${hand.length}张 · 已选${selected.length}张` : '手牌轮到当前玩家时显示';
  const hiddenHandHint = state.phase === 'tribute'
    ? '请查看右侧上供与还牌明细'
    : room ? '本局尚未发牌' : isBotTurn() ? `${playerName(viewer)}思考中…` : '手牌暂时隐藏';
  const roomControls = room ? `<span class="chip">房间 <strong>${escapeHtml(room.code)}</strong></span><button class="btn" data-action="copy-room">复制邀请链接</button><button class="btn" data-action="edit-names">修改昵称</button>` : `<button class="btn" data-action="edit-names">修改昵称</button><button class="btn" data-action="new">新开一局</button>`;
  app.innerHTML = `<header><div class="brand"><div class="mark">♣</div><div><h1>新疆双扣</h1><div class="sub">${room ? '四人房间 · 服务端同步' : '单机人机 · 本地多人 · 联机房间'}</div></div></div><div class="top">${roomControls}</div></header>
    <div class="chips"><span class="chip"><strong>${stageLabel()}</strong></span>${state.dealer !== null ? `<span class="chip">庄家 <strong>${escapeHtml(playerName(state.dealer))}</strong></span>` : ''}${trump ? `<span class="chip">主花色 <strong>${trump.symbol} ${trump.name}</strong></span>` : ''}<span class="chip">已打 <strong>${state.trickCount}</strong>墩</span></div>
    <div class="layout"><main class="table"><div class="seats">${[0, 1, 2, 3].map(id => seatHtml(id as PlayerId, viewer)).join('')}
      <div class="center"><div class="centerLabel">${state.phase === 'play' ? '本墩出牌' : '牌桌'}</div><div class="plays">${trickHtml()}</div></div></div>
      <div class="notice">${escapeHtml(notice || instruction())}</div>
      <div class="handArea"><div class="handHead"><span><strong>${escapeHtml(handTitle)}</strong></span><span>${handStatus}</span></div>
      <div class="hand">${handVisible ? hand.map(handCardHtml).join('') : `<div class="handEmpty">${escapeHtml(hiddenHandHint)}</div>`}</div><div class="controls">${actionButtons()}</div></div>
      <div class="footerNote">双副牌108张；5计5分，10和K各计10分。牌面顺序会在确定主花色后自动整理。</div></main>
      <aside class="side"><section><div class="scores"><div class="score"><div class="scoreLabel">庄家队</div><div class="scoreValue">${state.scores[0]}</div></div><div class="score"><div class="scoreLabel">闲家队</div><div class="scoreValue">${state.scores[1]}</div></div></div></section>
      ${state.phase === 'tribute' ? `<section><h2>上供与还牌</h2>${tributeSummaryHtml()}</section>` : ''}
      <section><h2>争庄</h2>${bidStatusHtml()}</section><section><h2>牌局提示</h2><div class="bidStatus">${escapeHtml(instruction())}${state.currentTrick.length ? `<br><br>本墩分牌：${revealedPoints}分` : ''}</div></section><section><h2>牌局记录</h2><div class="log">${history.length ? history.map(item => `<div class="logItem">${escapeHtml(item)}</div>`).join('') : '<span>等待开局</span>'}</div></section></aside></div>${overlayHtml()}`;
}

function selectedCards(): readonly Card[] {
  const hand = currentHand();
  return selected.map(id => hand.find(card => card.id === id)).filter((card): card is Card => card !== undefined);
}
function setState(next: GameState, message: string, requirePass: boolean, preserveSelection = false): void {
  if (botTimer !== null) {
    window.clearTimeout(botTimer);
    botTimer = null;
  }
  if (state.phase !== 'bidding' && next.phase === 'bidding') biddingViewer = 0;
  state = next;
  if (!preserveSelection) selected = [];
  notice = message;
  const viewer = activePlayer();
  needsPass = requirePass && isHumanPlayer(viewer) && lastHumanPlayer !== viewer;
  if (isHumanPlayer(viewer) && !needsPass) lastHumanPlayer = viewer;
  history = [message, ...history].slice(0, 14);
  render();
  scheduleBotTurn();
}
function submitBid(cards: readonly Card[] = selectedCards(), player: PlayerId = activePlayer()): void {
  finishBidResponse(recordBid(state, cards, player), player, `${playerName(player)}已提交叫庄牌；牌面仍封存。`);
}
function submitPass(player: PlayerId = activePlayer()): void {
  finishBidResponse(passBid(state, player), player, `${playerName(player)}选择不争庄。`);
}
function finishBidResponse(next: GameState, player: PlayerId, message: string): void {
  const oldViewer = activePlayer();
  if (next.bidTurn === 4) {
    next = resolveBidding(next);
    message = next.forcedBidder !== null
      ? `无人主动叫庄，按顺时针由${playerName(next.forcedBidder)}强制叫庄。`
      : next.dealer === null ? '四家都没有可叫的对子或拖拉机，请重新发牌。' : `争庄牌已统一揭晓，${playerName(next.dealer)}成为庄家。`;
  }
  if (next.phase === 'bidding' && next.forcedBidder === null && next.bidResponded.includes(biddingViewer)) {
    biddingViewer = ([0, 1, 2, 3] as const).find(id => id < humanCount && !next.bidResponded.includes(id)) ?? biddingViewer;
  }
  const nextViewer = next.phase === 'bidding' ? next.forcedBidder ?? biddingViewer : next.currentPlayer;
  const preserveSelection = !isHumanPlayer(player) && next.phase === 'bidding' && nextViewer === oldViewer && canRespondToBid(next, oldViewer);
  setState(next, message, needsPass || nextViewer !== oldViewer, preserveSelection);
}
function doExchange(returned: readonly Card[] = selectedCards()): void {
  const loser = state.pendingExchange[0];
  const next = exchangeBidCards(state, returned);
  setState(next, loser === undefined ? '换牌完成。' : `庄家已向${playerName(loser)}还牌。`, false);
}
function doCallPartner(called: Card | undefined = selectedCards()[0]): void {
  if (!called) throw new Error('请选择一张叫队友的牌。');
  const next = callPartner(state, called);
  setState(next, `庄家叫出${face(called)}，开始出牌。`, false);
}
function doPlay(cards: readonly Card[] = selectedCards()): void {
  const player = activePlayer();
  const oldPlayer = player;
  const next = playTurn(state, player, cards);
  const message = next.phase === 'round-end'
    ? `本局结束：${next.winnerTeam === null ? '双方平分' : next.winnerTeam === 0 ? '庄家队获胜' : '闲家队获胜'}。`
    : next.currentTrick.length === 0 ? `${playerName(next.currentPlayer)}赢下本墩并领出。` : `${playerName(oldPlayer)}出牌完成。`;
  setState(next, message, next.phase === 'play' && next.currentPlayer !== oldPlayer);
}

function runBotTurn(): void {
  if (!isBotTurn()) return;
  if (state.phase === 'exchange') { doExchange(chooseBotExchange(state)); return; }
  if (state.phase === 'partner-call') { doCallPartner(chooseBotCalledCard(state)); return; }
  if (state.phase === 'play') { doPlay(chooseBotPlay(state)); }
}

function scheduleBotTurn(): void {
  if (state.phase === 'bidding') {
    scheduleBotBids();
    return;
  }
  clearBotBids();
  if (needsSetup || showNameEditor || needsPass || !isBotTurn() || ['dealing', 'round-end', 'tribute'].includes(state.phase) || botTimer !== null) return;
  notice = `${playerName(activePlayer())}思考中…`;
  render();
  botTimer = window.setTimeout(() => {
    botTimer = null;
    try {
      runBotTurn();
    } catch (error) {
      notice = error instanceof Error ? error.message : '人机操作失败。';
      render();
    }
  }, 420);
}
function clearBotBids(): void {
  for (const timer of bidBotTimers.values()) window.clearTimeout(timer);
  bidBotTimers.clear();
}
function mustWaitForLosingBid(player: PlayerId): boolean {
  return state.fullSupply && state.forcedBidder === null && state.bidRequirement === null
    && !state.previousLosingTeam?.includes(player)
    && (state.previousLosingTeam?.some(id => !state.bidResponded.includes(id)) ?? false);
}
function scheduleBotBids(): void {
  if (room || needsSetup) return;
  for (const player of [0, 1, 2, 3] as const) {
    if (isHumanPlayer(player) || !canRespondToBid(state, player) || bidBotTimers.has(player) || mustWaitForLosingBid(player)) continue;
    const delay = state.forcedBidder === player ? 420 : 2500 + randomValues(1)[0] * 5000;
    bidBotTimers.set(player, window.setTimeout(() => {
      bidBotTimers.delete(player);
      if (room || needsSetup || !canRespondToBid(state, player) || mustWaitForLosingBid(player)) return;
      try {
        const cards = chooseBotBid(state, player);
        if (cards) submitBid(cards, player);
        else submitPass(player);
      } catch (error) {
        notice = error instanceof Error ? error.message : '人机叫庄失败。';
        render();
      }
    }, delay));
  }
}
function restart(): void {
  const previousDealer = state.dealer ?? state.previousDealer;
  history = [];
  setState(createGameState(deal(), previousDealer), '新一局已发牌。', true);
}
function startNextRound(): void {
  if (state.winnerTeam === null || state.dealer === null || state.partner === null || state.trumpSuit === null) {
    const previousDealer = state.dealer ?? state.previousDealer;
    const freshState = createGameState(deal(), previousDealer);
    setState(beginTributePhase({ ...state, fullSupply: false, previousLosingTeam: null }, freshState.players, []), '本轮无需上供，请查看牌桌提示后开始下一局。', false);
    return;
  }
  const previousDealer = state.dealer;
  const winningTeam: readonly [PlayerId, PlayerId] = state.winnerTeam === 0
    ? [state.dealer, state.partner]
    : [([0, 1, 2, 3] as const).filter(id => id !== state.dealer && id !== state.partner)[0], ([0, 1, 2, 3] as const).filter(id => id !== state.dealer && id !== state.partner)[1]];
  const losingTeam: readonly [PlayerId, PlayerId] = state.winnerTeam === 0
    ? [([0, 1, 2, 3] as const).filter(id => id !== state.dealer && id !== state.partner)[0], ([0, 1, 2, 3] as const).filter(id => id !== state.dealer && id !== state.partner)[1]]
    : [state.dealer, state.partner];
  const net = Math.abs(state.scores[0] - state.scores[1]);
  const requested = supplyCount(net);
  const newHands = deal();
  const temporaryPlayers: GameState['players'] = [
    { id: 0, hand: newHands[0] }, { id: 1, hand: newHands[1] },
    { id: 2, hand: newHands[2] }, { id: 3, hand: newHands[3] }
  ];
  let dealState: GameState = { ...state, phase: 'dealing', players: temporaryPlayers };
  let noticeText = requested === 0 ? '净胜不足20分，本轮不上供。' : `按净胜分计算上${requested}供。`;
  const antiSupply = requested === 8 && teamCanAntiSupply(dealState, losingTeam, state.trumpSuit);
  const fullSupply = requested === 8 && !antiSupply;
  let tributeExchanges: GameState['tributeExchanges'] = [];
  if (antiSupply) {
    noticeText = '输家成功抗满供，本轮不上供。';
  } else if (requested > 0) {
    const quotas = splitTeamQuota(requested, losingTeam, previousDealer);
    const offers = new Map<PlayerId, readonly Card[]>([
      [losingTeam[0], chooseTributeCards(dealState.players[losingTeam[0]].hand, quotas[0], state.trumpSuit)],
      [losingTeam[1], chooseTributeCards(dealState.players[losingTeam[1]].hand, quotas[1], state.trumpSuit)]
    ]);
    const slots = shuffleArray(losingTeam.flatMap(loser => (offers.get(loser) ?? []).map(card => ({ loser, card }))));
    const actual = slots.length;
    if (actual > 0) {
      const winners = splitTeamQuota(actual, winningTeam, previousDealer);
      const winnerSlots = new Map<PlayerId, typeof slots>([[winningTeam[0], []], [winningTeam[1], []]]);
      let cursor = 0;
      for (const winner of winningTeam) {
        const quota = winner === winningTeam[0] ? winners[0] : winners[1];
        winnerSlots.set(winner, slots.slice(cursor, cursor + quota));
        cursor += quota;
      }
      const exchanges = new Map<string, { from: PlayerId; to: PlayerId; offered: Card[]; returned: Card[] }>();
      for (const winner of winningTeam) {
        const received = winnerSlots.get(winner) ?? [];
        const returned = randomReturnCards(dealState.players[winner].hand, received.length);
        received.forEach((slot, index) => {
          const key = `${slot.loser}:${winner}`;
          const exchange = exchanges.get(key) ?? { from: slot.loser, to: winner, offered: [], returned: [] };
          exchange.offered.push(slot.card);
          exchange.returned.push(returned[index]);
          exchanges.set(key, exchange);
        });
      }
      tributeExchanges = [...exchanges.values()];
      noticeText = `已完成${actual}供：输家按规定上牌，赢家分供并还牌。请查看明细。`;
    } else {
      noticeText = '输家没有足够的合格主牌，本轮未能上供。';
    }
  }
  const tributeState = beginTributePhase(
    { ...state, fullSupply, previousLosingTeam: fullSupply ? losingTeam : null },
    temporaryPlayers,
    tributeExchanges
  );
  setState(tributeState, noticeText, false);
}

function continueAfterTribute(): void {
  if (state.phase !== 'tribute') throw new Error('当前没有待确认的上供结果。');
  const previousDealer = state.dealer ?? state.previousDealer;
  const hands: ReturnType<typeof dealHands> = [
    state.players[0].hand, state.players[1].hand,
    state.players[2].hand, state.players[3].hand
  ];
  const message = state.tributeExchanges.length ? '上供还牌完成，新一局已发牌。' : '本轮无需上供，新一局已发牌。';
  setState(createGameState(hands, previousDealer, {
    fullSupply: state.fullSupply,
    previousLosingTeam: state.previousLosingTeam
  }), message, true);
}

function startLocalGame(): void {
  clearBotBids();
  biddingViewer = 0;
  humanCount = draftHumanCount;
  humanNames = humanNames.map((_, index) => draftNames[index].trim() || `玩家${index + 1}`);
  needsSetup = false;
  lastHumanPlayer = null;
  history = [];
  setState(createGameState(deal(), state.previousDealer), `${humanCount}名真人玩家加入，开始发牌。`, false);
}

function configureNewGame(): void {
  if (!window.confirm('要结束当前牌局并重新设置玩家人数吗？')) return;
  clearBotBids();
  if (botTimer !== null) window.clearTimeout(botTimer);
  botTimer = null;
  draftHumanCount = humanCount;
  draftNames = [...humanNames];
  needsSetup = true;
  showNameEditor = false;
  needsPass = false;
  selected = [];
  notice = '选择真人玩家数量，开始游戏。';
  render();
}

async function saveNames(): Promise<void> {
  if (room) {
    const name = draftNames[room.playerId].trim() || `玩家${room.playerId + 1}`;
    const snapshot = await roomRequest<RoomSnapshot>(`/api/rooms/${room.code}/name`, { name });
    showNameEditor = false;
    applyRoomSnapshot(snapshot, true);
    return;
  }
  humanNames = humanNames.map((name, index) => index < humanCount ? draftNames[index].trim() || `玩家${index + 1}` : name);
  showNameEditor = false;
  notice = '玩家昵称已更新。';
  history = [notice, ...history].slice(0, 14);
  render();
}

async function startRoom(): Promise<void> {
  if (!room) return;
  const snapshot = await roomRequest<RoomSnapshot>(`/api/rooms/${room.code}/start`, {});
  applyRoomSnapshot(snapshot, true);
}

async function leaveRoom(): Promise<void> {
  if (!room || roomSnapshot?.game) return;
  await roomRequest<{ readonly left: boolean }>(`/api/rooms/${room.code}/leave`, {});
  if (roomPollTimer !== null) window.clearTimeout(roomPollTimer);
  roomPollTimer = null;
  room = null;
  roomSnapshot = null;
  saveRoomIdentity(null);
  needsSetup = true;
  roomFormMode = null;
  notice = '已离开房间。';
  render();
}

async function copyRoomLink(): Promise<void> {
  if (!roomSnapshot) return;
  try {
    await navigator.clipboard.writeText(roomSnapshot.inviteUrl);
    notice = '邀请链接已复制。';
  } catch {
    notice = `邀请链接：${roomSnapshot.inviteUrl}`;
  }
  render();
}

function randomReturnCards(hand: readonly Card[], count: number): readonly Card[] {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const shuffled = shuffleCards(hand, randomValues(Math.max(0, hand.length - 1)));
    const candidate = shuffled.slice(0, count);
    if (preservesEverySuit(hand, candidate)) return candidate;
  }
  throw new Error('无法随机选出符合花色保留规则的还牌。');
}
async function runAction(action: string): Promise<void> {
  try {
    if (action === 'create-room') { roomFormMode = 'create'; roomNameInput = humanNames[0]; modalError = ''; render(); return; }
    if (action === 'join-room') { roomFormMode = 'join'; roomNameInput = humanNames[0]; modalError = ''; render(); return; }
    if (action === 'back-to-setup') { roomFormMode = null; modalError = ''; render(); return; }
    if (action === 'submit-room-create') { await createRoom(); return; }
    if (action === 'submit-room-join') { await joinRoom(); return; }
    if (action === 'start-room') { await startRoom(); return; }
    if (action === 'copy-room') { await copyRoomLink(); return; }
    if (action === 'leave-room') { await leaveRoom(); return; }
    if (action === 'reveal') { needsPass = false; lastHumanPlayer = activePlayer(); notice = instruction(); render(); return; }
    if (action === 'clear') { selected = []; render(); return; }
    if (action === 'start-local') { startLocalGame(); return; }
    if (action === 'edit-names') { draftNames = [...humanNames]; modalError = ''; showNameEditor = true; render(); return; }
    if (action === 'save-names') { await saveNames(); return; }
    if (action === 'cancel-names') { showNameEditor = false; modalError = ''; render(); return; }
    if (room && ['bid', 'pass', 'exchange', 'call', 'play', 'redeal', 'next', 'continue-next'].includes(action)) {
      await submitRoomAction(action);
      return;
    }
    if (action === 'bid') { submitBid(); return; }
    if (action === 'pass') { submitPass(); return; }
    if (action === 'exchange') { doExchange(); return; }
    if (action === 'call') { doCallPartner(); return; }
    if (action === 'play') { doPlay(); return; }
    if (action === 'redeal') { restart(); return; }
    if (action === 'next') { startNextRound(); return; }
    if (action === 'continue-next') { continueAfterTribute(); return; }
    if (action === 'new') { configureNewGame(); return; }
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作无效。';
    if ((needsSetup && roomFormMode) || showNameEditor) modalError = message;
    else notice = message;
    render();
  }
}

app.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const bidderButton = target.closest<HTMLButtonElement>('[data-bid-viewer]');
  if (bidderButton?.dataset.bidViewer && !room && state.phase === 'bidding' && state.forcedBidder === null) {
    const player = Number(bidderButton.dataset.bidViewer) as PlayerId;
    if (![0, 1, 2, 3].includes(player) || player >= humanCount || !canRespondToBid(state, player)) return;
    biddingViewer = player;
    selected = [];
    needsPass = lastHumanPlayer !== player;
    render();
    return;
  }
  const countButton = target.closest<HTMLButtonElement>('[data-count]');
  if (countButton?.dataset.count) {
    draftHumanCount = Number(countButton.dataset.count);
    render();
    return;
  }
  const cardButton = target.closest<HTMLButtonElement>('[data-card]');
  if (cardButton && !needsPass && !needsSetup && !showNameEditor && !roomRequestPending && isHumanPlayer(activePlayer()) && (!room || room.playerId === activePlayer()) && (state.phase !== 'bidding' || canRespondToBid(state, activePlayer()))) {
    const id = cardButton.dataset.card;
    if (!id) return;
    selected = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
    notice = instruction();
    render();
    return;
  }
  const actionButton = target.closest<HTMLButtonElement>('[data-action]');
  if (actionButton?.dataset.action) void runAction(actionButton.dataset.action);
});

app.addEventListener('input', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const draftIndex = target.dataset.draftName;
  const editIndex = target.dataset.editName;
  const roomName = target.dataset.roomName;
  const roomCode = target.dataset.roomCode;
  if (draftIndex !== undefined) draftNames[Number(draftIndex)] = target.value;
  if (editIndex !== undefined) draftNames[Number(editIndex)] = target.value;
  if (roomName !== undefined) roomNameInput = target.value;
  if (draftIndex !== undefined || editIndex !== undefined || roomName !== undefined || roomCode !== undefined) modalError = '';
  if (roomCode !== undefined) {
    roomCodeInput = target.value.toUpperCase();
    target.value = roomCodeInput;
  }
});

render();
if (room) startRoomPolling();
