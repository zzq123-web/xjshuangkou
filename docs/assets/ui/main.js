import { classifyBid } from '../game/bid.js';
import { createDeck, dealHands, shuffleCards } from '../game/deck.js';
import { bidReturnCount, callPartner, canRespondToBid, createGameState, exchangeBidCards, passBid, playTurn, recordBid, resolveBidding, resumeAfterTribute, revealedBids } from '../game/engine.js';
import { sortHandForDisplay } from '../game/trump.js';
import { beginInteractiveTribute, submitTributeOffer, submitTributeReturn } from '../game/tribute.js';
import { cardFaceLabel, eventLabel, visibleEvents } from '../game/view.js';
import { chooseBotBid, chooseBotCalledCard, chooseBotExchange, chooseBotPlay, chooseBotTribute } from './bot.js';
                                                                  

const SUITS = {
  clubs: { name: '梅花', symbol: '♣', red: false },
  spades: { name: '黑桃', symbol: '♠', red: false },
  hearts: { name: '红桃', symbol: '♥', red: true },
  diamonds: { name: '方片', symbol: '♦', red: true }
}         ;
const appElement = document.querySelector                ('#app');
if (!appElement) throw new Error('App container is missing.');
const app                 = appElement;

                        
                        
                         
                              
 

                          
                        
                        
                          
 

                        
                        
                            
                              
                             
                                                      
                           
                                              
                                  
                           
                                      
 

class RoomRequestError extends Error {
           statusCode        ;

  constructor(statusCode        , message        ) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'RoomRequestError';
  }
}

function loadRoomIdentity()                      {
  try {
    const raw          = JSON.parse(localStorage.getItem('shuangkou-room') ?? 'null');
    if (typeof raw !== 'object' || raw === null) return null;
    const data = raw                           ;
    if (typeof data.code !== 'string' || typeof data.token !== 'string' || typeof data.playerId !== 'number') return null;
    if (![0, 1, 2, 3].includes(data.playerId)) return null;
    return { code: data.code, token: data.token, playerId: data.playerId             };
  } catch {
    return null;
  }
}

function initialRoomCode()         {
  return new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() ?? '';
}

let state = createGameState(deal(), 0);
let selected           = [];
const requestedRoomCode = initialRoomCode();
const storedRoom = loadRoomIdentity();
let room = requestedRoomCode && storedRoom?.code !== requestedRoomCode ? null : storedRoom;
let roomSnapshot                      = null;
let roomPollTimer                = null;
let roomRequestPending = false;
let needsPass = false;
let needsSetup = room === null;
let showNameEditor = false;
let humanCount = room ? 4 : 1;
let draftHumanCount = 1;
let humanNames = ['玩家1', '玩家2', '玩家3', '玩家4'];
let draftNames = [...humanNames];
let lastHumanPlayer                  = null;
let botTimer                = null;
let biddingViewer           = 0;
const bidBotTimers = new Map                  ();
let roomFormMode                           = initialRoomCode() ? 'join' : null;
let roomCodeInput = initialRoomCode();
let roomNameInput = '玩家';
let modalError = '';
let notice = '选择真人玩家数量，开始游戏。';
let history           = [];

function deal()                               {
  return dealHands(shuffleCards(createDeck(), randomValues(107)));
}

function randomValues(count        )           {
  const values = new Uint32Array(count);
  crypto.getRandomValues(values);
  return Array.from(values, value => value / 0x1_0000_0000);
}

                           
                         
                           
                                       
 

async function roomRequest   (path        , body                  , token                            = room?.token)             {
  const headers = new Headers();
  if (body) headers.set('content-type', 'application/json');
  if (token) headers.set('x-room-token', token);
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const result          = await response.json();
  if (!response.ok) {
    const errorMessage = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
      ? result.error
      : '房间请求失败。';
    throw new RoomRequestError(response.status, errorMessage);
  }
  return result     ;
}

function saveRoomIdentity(identity                     )       {
  if (!identity) {
    localStorage.removeItem('shuangkou-room');
    return;
  }
  localStorage.setItem('shuangkou-room', JSON.stringify(identity));
}

function applyRoomSnapshot(snapshot              , force = false)       {
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

function startRoomPolling()       {
  if (roomPollTimer !== null) window.clearTimeout(roomPollTimer);
  roomPollTimer = null;
  if (room) void pollRoom();
}

async function pollRoom()                {
  const identity = room;
  if (!identity) return;
  try {
    const snapshot = await roomRequest              (`/api/rooms/${identity.code}`, undefined, identity.token);
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

function saveRoomAndEnter(identity              , snapshot              )       {
  room = identity;
  saveRoomIdentity(identity);
  needsSetup = false;
  needsPass = false;
  showNameEditor = false;
  humanCount = 4;
  applyRoomSnapshot(snapshot, true);
  startRoomPolling();
}

async function createRoom()                {
  const response = await roomRequest                                                                                          (
    '/api/rooms', { name: roomNameInput }, null
  );
  saveRoomAndEnter({ code: response.snapshot.code, token: response.token, playerId: response.playerId }, response.snapshot);
}

async function joinRoom()                {
  const code = roomCodeInput.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('请输入6位房间号。');
  const response = await roomRequest                                                                                          (
    `/api/rooms/${code}/join`, { name: roomNameInput }, null
  );
  saveRoomAndEnter({ code, token: response.token, playerId: response.playerId }, response.snapshot);
}

async function submitRoomAction(action        )                {
  if (!room || roomRequestPending) return;
  roomRequestPending = true;
  render();
  try {
    const cardIds = action === 'pass' ? [] : selectedCards().map(card => card.id);
    const snapshot = await roomRequest              (`/api/rooms/${room.code}/action`, { action, cardIds });
    applyRoomSnapshot(snapshot, true);
  } catch (error) {
    notice = error instanceof Error ? error.message : '操作失败。';
    render();
  } finally {
    roomRequestPending = false;
    render();
  }
}

function escapeHtml(value        )         {
  const replacements                                   = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, character => replacements[character] ?? character);
}
function isHumanPlayer(id          )          { return room !== null || id < humanCount; }
function playerName(id          )         {
  if (room && roomSnapshot) return roomSnapshot.players[id]?.name ?? `玩家${id + 1}`;
  if (isHumanPlayer(id)) return humanNames[id].trim() || `玩家${id + 1}`;
  return `人机${id - humanCount + 1}`;
}
function face(card      )         {
  if (card.rank === 'BJ') return '大王';
  if (card.rank === 'SJ') return '小王';
  return `${SUITS[card.suit                      ].name}${card.rank}`;
}
function shortFace(card      )         {
  if (card.rank === 'BJ') return '大王';
  if (card.rank === 'SJ') return '小王';
  return `${SUITS[card.suit                      ].symbol}${card.rank}`;
}
function faceColor(card      )         {
  return card.suit === 'joker' || SUITS[card.suit                      ]?.red ? 'red' : '';
}
function pointsFor(card      )         {
  return card.rank === '5' ? 5 : card.rank === '10' || card.rank === 'K' ? 10 : 0;
}
function activePlayer()           {
  if (state.phase === 'bidding') return room?.playerId ?? state.forcedBidder ?? biddingViewer;
  return state.currentPlayer;
}
function viewingPlayer()           {
  if (room) return room.playerId;
  if (humanCount === 1) return 0;
  return !needsPass && isHumanPlayer(activePlayer()) ? activePlayer() : lastHumanPlayer ?? 0;
}
function currentHand()                  { return state.players[activePlayer()].hand; }
function isBotTurn()          { return !isHumanPlayer(activePlayer()); }

function bidLabel(cards                 )         {
  const shape = classifyBid(cards);
  if (!shape) return '无效叫牌';
  if (shape.kind === 'pair') return `对子 ${face(cards[0])}`;
  return `${shape.cardCount}张拖拉机 ${SUITS[cards[0].suit                      ].name} ${cards[0].rank}起`;
}

function seatClass(id          , viewer          )         {
  const relative = (id - viewer + 4) % 4;
  return ['seat-bottom', 'seat-right', 'seat-top', 'seat-left'][relative];
}
function teamLabel(id          )         {
  if (state.dealer === null || state.partner === null) return '';
  return id === state.dealer || id === state.partner ? '庄家队' : '闲家队';
}
function seatHtml(id          , viewer          )         {
  const player = state.players[id];
  const isCurrent = state.phase === 'bidding' ? canRespondToBid(state, id)
    : id === activePlayer() && !['round-end', 'dealing'].includes(state.phase);
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
function playedCardHtml(card      )         {
  if (card.suit === 'joker') return `<span class="tinyCard red"><span>${face(card)}</span><span class="tinySuit">★</span></span>`;
  const suit = SUITS[card.suit];
  return `<span class="tinyCard ${suit.red ? 'red' : ''}"><span>${card.rank}</span><span class="tinySuit">${suit.symbol}</span></span>`;
}
function handCardHtml(card      )         {
  const isSelected = selected.includes(card.id);
  const color = faceColor(card);
  if (card.suit === 'joker') {
    return `<button class="card ${color} ${isSelected ? 'selected' : ''}" data-card="${card.id}" aria-label="${face(card)}"><span class="jokerText">${face(card)}</span><span class="symbol">${card.rank === 'BJ' ? '★' : '☆'}</span></button>`;
  }
  const suit = SUITS[card.suit];
  return `<button class="card ${color} ${isSelected ? 'selected' : ''}" data-card="${card.id}" aria-label="${face(card)}"><span class="rank">${card.rank}</span><span class="symbol">${suit.symbol}</span></button>`;
}
function trickHtml()         {
  if (!state.currentTrick.length) return '<span class="empty">等待首家领牌</span>';
  return state.currentTrick.map(play => `<div class="played"><span class="playedName">${escapeHtml(playerName(play.player))}</span><div class="playedCards">${play.cards.map(playedCardHtml).join('')}</div></div>`).join('');
}
function stageLabel()         {
  const labels                                     = {
    dealing: '重新发牌', bidding: '抢庄', exchange: '庄家换牌', 'partner-call': '叫队友', play: `第${state.trickCount + 1}墩`, 'round-end': '本局结算', tribute: '上供还牌'
  };
  return labels[state.phase];
}
function actionButtons()         {
  if (state.phase === 'dealing') return !room || room.playerId === roomSnapshot?.hostId ? '<button class="btn primary" data-action="redeal">重新发牌</button>' : '';
  if (state.phase === 'round-end') return roomRequestPending ? '' : !room || room.playerId === roomSnapshot?.hostId
    ? '<button class="btn primary" data-action="next">开始上供</button>'
    : '<span class="roomHint">等待房主开始上供…</span>';
  if (state.phase === 'tribute') {
    const progress = state.tribute;
    if (!progress || progress.stage === 'complete') return !room || room.playerId === roomSnapshot?.hostId
      ? '<button class="btn primary" data-action="continue-next">开始下一局</button>' : '';
    if (roomRequestPending || needsPass || isBotTurn() || (room && room.playerId !== state.currentPlayer)) return '<span class="roomHint">等待当前玩家选牌确认…</span>';
    const offering = progress.stage === 'offering';
    const count = offering ? progress.offerCounts[state.currentPlayer] : progress.receiveCounts[state.currentPlayer];
    return '<button class="btn primary" data-action="' + (offering ? 'tribute-offer' : 'tribute-return') + '">确认' + (offering ? '上供' : '还牌') + '（' + count + '张）</button><button class="btn" data-action="clear">清除选牌</button>';
  }
  if (state.phase === 'bidding') {
    if (roomRequestPending || needsPass || isBotTurn()) return '';
    const player = activePlayer();
    const switchers = !room && humanCount > 1 && state.forcedBidder === null
      ? `<div class="controls">${([0, 1, 2, 3]         ).filter(id => id < humanCount && id !== player && canRespondToBid(state, id)).map(id => `<button class="btn" data-bid-viewer="${id}">交给${escapeHtml(playerName(id))}抢叫</button>`).join('')}</div>` : '';
    if (!canRespondToBid(state, player)) return `<span class="roomHint">已完成选择，等待其他玩家…</span>${switchers}`;
    return `<button class="btn primary" data-action="bid">${state.forcedBidder !== null ? '强制叫庄' : '抢叫庄'}</button>${state.forcedBidder === null ? '<button class="btn" data-action="pass">不争</button>' : ''}<button class="btn" data-action="clear">清除选牌</button>${switchers}`;
  }
  if (room && (roomRequestPending || room.playerId !== state.currentPlayer)) return '';
  if (isBotTurn() || needsPass) return '';
  if (state.phase === 'exchange') return `<button class="btn primary" data-action="exchange">确认还牌（${bidReturnCount(state)}张）</button><button class="btn" data-action="clear">清除选牌</button>`;
  if (state.phase === 'partner-call') return '<button class="btn primary" data-action="call">确认叫队友</button><button class="btn" data-action="clear">清除选牌</button>';
  if (state.phase === 'play') return '<button class="btn primary" data-action="play">出牌</button><button class="btn" data-action="clear">清除选牌</button>';
  return '';
}
function instruction()         {
  if (state.phase === 'tribute') {
    const progress = state.tribute;
    if (!progress || progress.stage === 'complete') return '上供还牌完成，每人27张，可以开始下一局。';
    const id = state.currentPlayer;
    return progress.stage === 'offering'
      ? playerName(id) + '请选择' + progress.offerCounts[id] + '张供牌：2、3、5或王，优先大牌，不能拆对子。所有输家提交后随机分供。'
      : playerName(id) + '请选择' + progress.receiveCounts[id] + '张还牌。允许还主牌，不能还绝任何一门副牌；所有赢家提交后随机分还牌。';
  }
  if (state.phase === 'bidding') {
    return state.forcedBidder !== null
      ? `四家均未叫庄，由${playerName(state.forcedBidder)}强制叫庄。`
      : state.fullSupply && state.bidRequirement === null && !state.previousLosingTeam?.includes(activePlayer())
        ? '满供规则：上一局赢家需要等输家先叫庄，之后可以参与叫庄。'
      : `${bidRequirementLabel()}无需按座位等待，牌的点数不必更大；四家选择完成后统一比大小定庄。`;
  }
  if (state.phase === 'exchange') return `庄家已收齐争庄牌，请一次选齐${bidReturnCount(state)}张还牌，系统按各家应得张数随机分配。不能还绝任何一门副牌。`;
  if (state.phase === 'partner-call') return '选择自己持有的一张副牌叫队友；不能叫主花色、2、3、5或大小王。';
  if (state.phase === 'play') return state.lead
    ? `首家出了 ${state.lead.cards.map(shortFace).join(' ')}。必须先跟首家副花色或主牌；没有时才能垫牌。`
    : `${playerName(activePlayer())}领牌：可出单张、对子或4/6张拖拉机。`;
  if (state.phase === 'dealing') return '四家都没有有效叫庄牌，按规则重新发牌。';
  const winner = state.winnerTeam === null ? '双方平分' : state.winnerTeam === 0 ? '庄家队获胜' : '闲家队获胜';
  return `本局结束：${winner}。当前总分 ${state.scores[0]} : ${state.scores[1]}。`;
}
function bidStatusHtml()         {
  if (!state.bidsRevealed) return `<div class="bidStatus">${bidRequirementLabel()}<br>${state.bidTurn}/4名玩家已完成选择；牌面封存，全部完成后统一揭晓。<br>${([0, 1, 2, 3]         ).map(id => `${escapeHtml(playerName(id))}：${state.bidResponded.includes(id) ? '已选择' : '待选择'}`).join(' · ')}</div>`;
  if (!state.bids.length) return '<div class="bidStatus">本局没有有效叫庄牌。</div>';
  return `<div class="bidStatus">${revealedBids(state).map(bid => `<div class="bidLine"><b>${escapeHtml(playerName(bid.player))}</b>：${bidLabel(bid.cards)} · ${bid.cards.map(card => `<span class="${faceColor(card)}">${shortFace(card)}</span>`).join(' ')}</div>`).join('')}</div>`;
}
function bidRequirementLabel()         {
  const requirement = state.bidRequirement;
  if (!requirement) return '自由抢叫，首个有效叫牌锁定牌型和张数。';
  return requirement.kind === 'pair' ? '本轮已锁定对子（2张）。' : `本轮已锁定${requirement.cardCount}张拖拉机。`;
}
function tributeSummaryHtml()         {
  const progress = state.tribute;
  if (!progress) return '<div class="bidStatus">换牌已完成。</div>';
  const offering = progress.stage === 'offering';
  const players = offering ? progress.losers : progress.winners;
  return '<div class="bidStatus">' + players.map(id => escapeHtml(playerName(id)) + '：' + (offering ? progress.offerCounts[id] : progress.receiveCounts[id]) + '张 · ' + ((offering ? progress.offers[id] : progress.returns[id]) === null ? '待选牌' : '已提交')).join('<br>') + '<br>自己的交牌和收牌明细见牌局记录。</div>';
}
function gameLogHtml()         {
  const privateVisible = !needsPass && !needsSetup && !showNameEditor;
  const events = privateVisible ? visibleEvents(state, viewingPlayer()) : (state.events ?? []).filter(event => event.viewer === null);
  const lines = events.length ? [...events].reverse().map(event => eventLabel(event, playerName(event.player))) : history;
  return lines.length ? lines.map(line => '<div class="logItem">' + escapeHtml(line) + '</div>').join('') : '<span>等待开局</span>';
}
function overlayHtml()         {
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
  if (room || !needsPass || ['dealing', 'round-end'].includes(state.phase)) return '';
  return `<div class="overlay"><div class="dialog"><h2>请交给${escapeHtml(playerName(activePlayer()))}</h2><p>轮到当前玩家查看手牌。请确认其他人看不到屏幕后继续。</p><button class="btn primary" data-action="reveal">我已接手</button></div></div>`;
}

function renderRoomLobby()       {
  if (!room || !roomSnapshot) return;
  const hostId = roomSnapshot.hostId;
  const readyCount = roomSnapshot.players.filter(player => player.ready).length;
  const seats = roomSnapshot.players.map((player, index) => `<div class="roomSeat ${player.ready ? 'ready' : ''}"><div><b>${['东家', '南家', '西家', '北家'][index]}</b>${index === hostId ? '<small>房主</small>' : ''}</div><span>${escapeHtml(player.ready ? player.name : '等待加入')}</span></div>`).join('');
  const startButton = room.playerId === roomSnapshot.hostId
    ? `<button class="btn primary" data-action="start-room" ${readyCount < 4 ? 'disabled' : ''}>${readyCount < 4 ? `等待玩家加入（${readyCount}/4）` : '四人到齐，开始游戏'}</button>`
    : '<p class="roomHint">等待房主开始游戏…</p>';
  app.innerHTML = `<header><div class="brand"><div class="mark">♣</div><div><h1>新疆双扣</h1><div class="sub">四人联机房间</div></div></div><div class="top"><button class="btn" data-action="copy-room">复制邀请链接</button><button class="btn" data-action="edit-names">修改昵称</button><button class="btn" data-action="leave-room">离开房间</button></div></header><main class="roomLobby"><span class="eyebrow">ROOM LOBBY</span><h2>等待玩家加入</h2><p>把房间号或邀请链接发给同一局域网内的玩家。</p><div class="roomCode">${escapeHtml(roomSnapshot.code)}</div><label class="inviteField"><span>邀请链接</span><input readonly value="${escapeHtml(roomSnapshot.inviteUrl)}" aria-label="邀请链接"></label><div class="roomSeats">${seats}</div><div class="roomActions">${startButton}</div><p class="roomHint">房间 ${escapeHtml(roomSnapshot.code)} · 你是${room.playerId === roomSnapshot.hostId ? '房主' : `${room.playerId + 1}号玩家`}</p><p class="roomHint">${escapeHtml(notice || roomSnapshot.message)}</p></main>${overlayHtml()}`;
}
function render()       {
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
  const viewer = viewingPlayer();
  const suit = state.trumpSuit;
  const hand = sortHandForDisplay(room ? state.players[room.playerId].hand : currentHand(), suit);
  const handVisible = room
    ? !showNameEditor && !['dealing', 'round-end'].includes(state.phase)
    : !needsSetup && !showNameEditor && !needsPass && !isBotTurn() && !['dealing', 'round-end'].includes(state.phase);
  const trump = suit ? SUITS[suit] : null;
  const revealedPoints = state.currentTrick.flatMap(play => play.cards).reduce((sum, card) => sum + pointsFor(card), 0);
  const handTitle = '我的手牌：' + playerName(viewer);
  const handStatus = handVisible ? hand.length + '张 · 已选' + selected.length + '张' : '手牌暂时隐藏';
  const hiddenHandHint = room ? '本局尚未发牌' : isBotTurn() ? playerName(activePlayer()) + '思考中…' : '请交接设备后查看自己的牌';
  const roomControls = room ? `<span class="chip">房间 <strong>${escapeHtml(room.code)}</strong></span><button class="btn" data-action="copy-room">复制邀请链接</button><button class="btn" data-action="edit-names">修改昵称</button>` : `<button class="btn" data-action="edit-names">修改昵称</button><button class="btn" data-action="new">新开一局</button>`;
  app.innerHTML = `<header><div class="brand"><div class="mark">♣</div><div><h1>新疆双扣</h1><div class="sub">${room ? '四人房间 · 服务端同步' : '单机人机 · 本地多人 · 联机房间'}</div></div></div><div class="top">${roomControls}</div></header>
    <div class="chips"><span class="chip"><strong>${stageLabel()}</strong></span>${state.dealer !== null ? `<span class="chip">庄家 <strong>${escapeHtml(playerName(state.dealer))}</strong></span>` : ''}${trump ? `<span class="chip">主花色 <strong>${trump.symbol} ${trump.name}</strong></span>` : ''}${state.calledCard ? `<span class="chip">叫队友牌 <strong>${cardFaceLabel(state.calledCard)}</strong></span>` : ''}<span class="chip">已打 <strong>${state.trickCount}</strong>墩</span></div>
    <div class="layout"><main class="table"><div class="seats">${[0, 1, 2, 3].map(id => seatHtml(id            , viewer)).join('')}
      <div class="center"><div class="centerLabel">${state.phase === 'play' ? '本墩出牌' : '牌桌'}</div><div class="plays">${trickHtml()}</div></div></div>
      <div class="notice">${escapeHtml(notice || instruction())}</div>
      <div class="handArea"><div class="handHead"><span><strong>${escapeHtml(handTitle)}</strong></span><span>${handStatus}</span></div>
      <div class="hand">${handVisible ? hand.map(handCardHtml).join('') : `<div class="handEmpty">${escapeHtml(hiddenHandHint)}</div>`}</div><div class="controls">${actionButtons()}</div></div>
      <div class="footerNote">双副牌108张；5计5分，10和K各计10分。牌面顺序会在确定主花色后自动整理。</div></main>
      <aside class="side"><section><div class="scores"><div class="score"><div class="scoreLabel">庄家队</div><div class="scoreValue">${state.scores[0]}</div></div><div class="score"><div class="scoreLabel">闲家队</div><div class="scoreValue">${state.scores[1]}</div></div></div></section>
      ${state.phase === 'tribute' ? `<section><h2>上供与还牌</h2>${tributeSummaryHtml()}</section>` : ''}
      <section><h2>争庄</h2>${bidStatusHtml()}</section><section><h2>牌局提示</h2><div class="bidStatus">${escapeHtml(instruction())}${state.currentTrick.length ? `<br><br>本墩分牌：${revealedPoints}分` : ''}</div></section><section><h2>牌局记录</h2><div class="log">${gameLogHtml()}</div></section></aside></div>${overlayHtml()}`;
}

function selectedCards()                  {
  const hand = currentHand();
  return selected.map(id => hand.find(card => card.id === id)).filter((card)               => card !== undefined);
}
function setState(next           , message        , requirePass         , preserveSelection = false)       {
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
function submitBid(cards                  = selectedCards(), player           = activePlayer())       {
  finishBidResponse(recordBid(state, cards, player), player, `${playerName(player)}已提交叫庄牌；牌面仍封存。`);
}
function submitPass(player           = activePlayer())       {
  finishBidResponse(passBid(state, player), player, `${playerName(player)}选择不争庄。`);
}
function finishBidResponse(next           , player          , message        )       {
  const oldViewer = activePlayer();
  if (next.bidTurn === 4) {
    next = resolveBidding(next);
    message = next.forcedBidder !== null
      ? `无人主动叫庄，按顺时针由${playerName(next.forcedBidder)}强制叫庄。`
      : next.dealer === null ? '四家都没有可叫的对子或拖拉机，请重新发牌。' : `争庄牌已统一揭晓，${playerName(next.dealer)}成为庄家。`;
  }
  if (next.phase === 'bidding' && next.forcedBidder === null && next.bidResponded.includes(biddingViewer)) {
    biddingViewer = ([0, 1, 2, 3]         ).find(id => id < humanCount && !next.bidResponded.includes(id)) ?? biddingViewer;
  }
  const nextViewer = next.phase === 'bidding' ? next.forcedBidder ?? biddingViewer : next.currentPlayer;
  const preserveSelection = !isHumanPlayer(player) && next.phase === 'bidding' && nextViewer === oldViewer && canRespondToBid(next, oldViewer);
  setState(next, message, needsPass || nextViewer !== oldViewer, preserveSelection);
}
function doExchange(returned                  = selectedCards())       {
  const next = exchangeBidCards(state, returned, randomValues(107));
  setState(next, '庄家已一次性还牌，系统已随机分配。', false);
}
function doTribute(cards                  = selectedCards())       {
  let next = state.tribute?.stage === 'offering'
    ? submitTributeOffer(state, activePlayer(), cards, randomValues(107))
    : submitTributeReturn(state, activePlayer(), cards, randomValues(107));
  const complete = next.tribute?.stage === 'complete';
  if (complete) next = resumeAfterTribute(next);
  setState(next, complete ? '还牌已随机分配，每人27张，开始新一局。' : next.tribute?.stage === 'returning' ? '供牌已随机分配，等待赢家选择还牌。' : '供牌已提交，等待另一位输家。', true);
}
function doCallPartner(called                   = selectedCards()[0])       {
  if (!called) throw new Error('请选择一张叫队友的牌。');
  const next = callPartner(state, called);
  setState(next, `庄家叫出${face(called)}，开始出牌。`, false);
}
function doPlay(cards                  = selectedCards())       {
  const player = activePlayer();
  const oldPlayer = player;
  const next = playTurn(state, player, cards);
  const message = next.phase === 'round-end'
    ? `本局结束：${next.winnerTeam === null ? '双方平分' : next.winnerTeam === 0 ? '庄家队获胜' : '闲家队获胜'}。`
    : next.currentTrick.length === 0 ? `${playerName(next.currentPlayer)}赢下本墩并领出。` : `${playerName(oldPlayer)}出牌完成。`;
  setState(next, message, next.phase === 'play' && next.currentPlayer !== oldPlayer);
}

function runBotTurn()       {
  if (!isBotTurn()) return;
  if (state.phase === 'tribute') { doTribute(chooseBotTribute(state)); return; }
  if (state.phase === 'exchange') { doExchange(chooseBotExchange(state)); return; }
  if (state.phase === 'partner-call') { doCallPartner(chooseBotCalledCard(state)); return; }
  if (state.phase === 'play') { doPlay(chooseBotPlay(state)); }
}

function scheduleBotTurn()       {
  if (state.phase === 'bidding') {
    scheduleBotBids();
    return;
  }
  clearBotBids();
  if (state.phase === 'tribute' && (!state.tribute || state.tribute.stage === 'complete')) return;
  if (needsSetup || showNameEditor || needsPass || !isBotTurn() || ['dealing', 'round-end'].includes(state.phase) || botTimer !== null) return;
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
function clearBotBids()       {
  for (const timer of bidBotTimers.values()) window.clearTimeout(timer);
  bidBotTimers.clear();
}
function mustWaitForLosingBid(player          )          {
  return state.fullSupply && state.forcedBidder === null && state.bidRequirement === null
    && !state.previousLosingTeam?.includes(player)
    && (state.previousLosingTeam?.some(id => !state.bidResponded.includes(id)) ?? false);
}
function scheduleBotBids()       {
  if (room || needsSetup) return;
  for (const player of [0, 1, 2, 3]         ) {
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
function restart()       {
  const previousDealer = state.dealer ?? state.previousDealer;
  history = [];
  setState(createGameState(deal(), previousDealer), '新一局已发牌。', true);
}
function startNextRound()       {
  const dealtPlayers = createGameState(deal(), state.dealer ?? state.previousDealer).players;
  let next = beginInteractiveTribute(state, dealtPlayers);
  const complete = next.tribute?.stage === 'complete';
  if (complete) next = resumeAfterTribute(next);
  setState(next, complete ? '本轮无需上供，开始新一局。' : '新牌已发，请输家自行选择供牌并确认。', true);
}

function continueAfterTribute()       {
  setState(resumeAfterTribute(state), '上供还牌完成，开始新一局。', true);
}

function startLocalGame()       {
  clearBotBids();
  biddingViewer = 0;
  humanCount = draftHumanCount;
  humanNames = humanNames.map((_, index) => draftNames[index].trim() || `玩家${index + 1}`);
  needsSetup = false;
  lastHumanPlayer = null;
  history = [];
  setState(createGameState(deal(), state.previousDealer), `${humanCount}名真人玩家加入，开始发牌。`, false);
}

function configureNewGame()       {
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

async function saveNames()                {
  if (room) {
    const name = draftNames[room.playerId].trim() || `玩家${room.playerId + 1}`;
    const snapshot = await roomRequest              (`/api/rooms/${room.code}/name`, { name });
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

async function startRoom()                {
  if (!room) return;
  const snapshot = await roomRequest              (`/api/rooms/${room.code}/start`, {});
  applyRoomSnapshot(snapshot, true);
}

async function leaveRoom()                {
  if (!room || roomSnapshot?.game) return;
  await roomRequest                            (`/api/rooms/${room.code}/leave`, {});
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

async function copyRoomLink()                {
  if (!roomSnapshot) return;
  try {
    await navigator.clipboard.writeText(roomSnapshot.inviteUrl);
    notice = '邀请链接已复制。';
  } catch {
    notice = `邀请链接：${roomSnapshot.inviteUrl}`;
  }
  render();
}

async function runAction(action        )                {
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
    if (room && ['bid', 'pass', 'exchange', 'tribute-offer', 'tribute-return', 'call', 'play', 'redeal', 'next', 'continue-next'].includes(action)) {
      await submitRoomAction(action);
      return;
    }
    if (action === 'bid') { submitBid(); return; }
    if (action === 'pass') { submitPass(); return; }
    if (action === 'exchange') { doExchange(); return; }
    if (action === 'tribute-offer' || action === 'tribute-return') { doTribute(); return; }
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
  const bidderButton = target.closest                   ('[data-bid-viewer]');
  if (bidderButton?.dataset.bidViewer && !room && state.phase === 'bidding' && state.forcedBidder === null) {
    const player = Number(bidderButton.dataset.bidViewer)            ;
    if (![0, 1, 2, 3].includes(player) || player >= humanCount || !canRespondToBid(state, player)) return;
    biddingViewer = player;
    selected = [];
    needsPass = lastHumanPlayer !== player;
    render();
    return;
  }
  const countButton = target.closest                   ('[data-count]');
  if (countButton?.dataset.count) {
    draftHumanCount = Number(countButton.dataset.count);
    render();
    return;
  }
  const cardButton = target.closest                   ('[data-card]');
  if (cardButton && !needsPass && !needsSetup && !showNameEditor && !roomRequestPending && isHumanPlayer(activePlayer()) && (!room || room.playerId === activePlayer()) && (state.phase !== 'bidding' || canRespondToBid(state, activePlayer()))) {
    const id = cardButton.dataset.card;
    if (!id) return;
    selected = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
    notice = instruction();
    render();
    return;
  }
  const actionButton = target.closest                   ('[data-action]');
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
