const API_BASE_URL = 'https://xinjiang-shuangkou-game.authenticauk1.chatgpt.site';

const canvas = wx.createCanvas();
const context = canvas.getContext('2d');
const systemInfo = wx.getSystemInfoSync();
const screenWidth = systemInfo.windowWidth;
const screenHeight = systemInfo.windowHeight;
canvas.width = screenWidth;
canvas.height = screenHeight;

const SUIT_SYMBOLS = {
  clubs: '♣',
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  joker: '★'
};

const PHASE_LABELS = {
  dealing: '发牌',
  bidding: '争庄',
  exchange: '争庄还牌',
  'partner-call': '叫队友',
  play: '出牌',
  tribute: '上供还牌',
  'round-end': '本局结束'
};

const state = {
  room: null,
  snapshot: null,
  selected: new Set(),
  notice: '请选择创建房间或加入房间。',
  pendingRoomCode: '',
  pollTimer: null,
  busy: false,
  buttons: [],
  cards: []
};

function loadIdentity() {
  try {
    const identity = wx.getStorageSync('shuangkou-minigame-room');
    if (!identity || typeof identity.code !== 'string' || typeof identity.token !== 'string') return null;
    return identity;
  } catch {
    return null;
  }
}

function saveIdentity(identity) {
  if (identity) wx.setStorageSync('shuangkou-minigame-room', identity);
  else wx.removeStorageSync('shuangkou-minigame-room');
}

function request(path, method, data) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (state.room && state.room.token) headers['x-room-token'] = state.room.token;
    wx.request({
      url: `${API_BASE_URL}${path}`,
      method: method || 'GET',
      data,
      header: headers,
      success(response) {
        const body = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body);
          return;
        }
        reject(new Error(body.error || `请求失败（${response.statusCode}）。`));
      },
      fail(error) {
        reject(new Error(error.errMsg || '网络连接失败，请检查服务器域名配置。'));
      }
    });
  });
}

function drawText(text, x, y, size, color, align) {
  context.font = `${size}px sans-serif`;
  context.fillStyle = color || '#f8f1e4';
  context.textAlign = align || 'left';
  context.textBaseline = 'middle';
  context.fillText(String(text), x, y);
}

function roundRect(x, y, width, height, radius, fill, stroke) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
  if (fill) {
    context.fillStyle = fill;
    context.fill();
  }
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 1;
    context.stroke();
  }
}

function button(label, x, y, width, height, action, enabled) {
  const active = enabled !== false;
  roundRect(x, y, width, height, 10, active ? '#d5ad64' : '#4d5b58', active ? '#f2d99e' : '#697874');
  drawText(label, x + width / 2, y + height / 2, 16, active ? '#17362d' : '#a6b0aa', 'center');
  if (active) state.buttons.push({ x, y, width, height, action });
}

function cardLabel(card) {
  if (!card) return '';
  if (card.suit === 'joker') return card.rank === 'BJ' ? '大王' : '小王';
  return `${SUIT_SYMBOLS[card.suit] || ''}${card.rank}`;
}

function cardColor(card) {
  return card && (card.suit === 'hearts' || card.suit === 'diamonds' || card.suit === 'joker') ? '#d75b4e' : '#16362d';
}

function phaseLabel(game) {
  return PHASE_LABELS[game.phase] || game.phase;
}

function currentPlayerName(game) {
  const players = state.snapshot && state.snapshot.players;
  if (!players || !game) return '';
  return players[game.currentPlayer] ? players[game.currentPlayer].name : `玩家${game.currentPlayer + 1}`;
}

function clearFrame() {
  context.clearRect(0, 0, screenWidth, screenHeight);
  context.fillStyle = '#0b2822';
  context.fillRect(0, 0, screenWidth, screenHeight);
  state.buttons = [];
  state.cards = [];
}

function drawHeader(title) {
  drawText(title, 18, 30, 22, '#f5ddaa');
  drawText('新疆双扣', screenWidth - 18, 30, 13, '#9eb2a8', 'right');
}

function drawHome() {
  drawHeader('开始游戏');
  drawText('微信小游戏版', screenWidth / 2, 112, 28, '#f8f1e4', 'center');
  drawText('使用房间号与其他玩家联机', screenWidth / 2, 146, 14, '#9eb2a8', 'center');
  button('创建联网房', 42, 250, screenWidth - 84, 52, 'create-room');
  button('加入联网房', 42, 320, screenWidth - 84, 52, 'join-room');
  drawText('首次运行需要在微信后台配置服务器域名。', screenWidth / 2, screenHeight - 38, 12, '#869b91', 'center');
}

function drawLobby() {
  const snapshot = state.snapshot;
  drawHeader('等待玩家');
  drawText(`房间号 ${snapshot.code}`, screenWidth / 2, 100, 30, '#f8f1e4', 'center');
  drawText('把房间号发给另外三位玩家', screenWidth / 2, 136, 14, '#9eb2a8', 'center');
  snapshot.players.forEach((player, index) => {
    const y = 190 + index * 52;
    roundRect(30, y - 20, screenWidth - 60, 40, 8, player.ready ? '#18443a' : '#112f29', '#315e50');
    drawText(`${index + 1}. ${player.name}`, 48, y, 16, player.ready ? '#f8f1e4' : '#8ca39a');
    drawText(player.ready ? '已加入' : '等待中', screenWidth - 48, y, 13, player.ready ? '#d5ad64' : '#71877e', 'right');
  });
  const ready = snapshot.players.every(player => player.ready);
  button('开始游戏', 42, 430, screenWidth - 84, 52, 'start-room', snapshot.playerId === snapshot.hostId && ready);
  button('刷新房间', 42, 500, screenWidth - 84, 44, 'refresh-room');
  drawText(state.notice, screenWidth / 2, screenHeight - 38, 12, '#c8d2cc', 'center');
}

function drawGame() {
  const snapshot = state.snapshot;
  const game = snapshot.game;
  if (!game) {
    drawLobby();
    return;
  }
  drawHeader(phaseLabel(game));
  const trump = game.trumpSuit ? SUIT_SYMBOLS[game.trumpSuit] : '未定';
  const partner = game.calledCard ? cardLabel(game.calledCard) : '未叫';
  drawText(`主牌 ${trump}   队友牌 ${partner}`, 18, 62, 14, '#d5ad64');
  drawText(`房间 ${snapshot.code}`, screenWidth - 18, 62, 12, '#9eb2a8', 'right');

  snapshot.players.forEach((player, index) => {
    const active = game.currentPlayer === index;
    drawText(`${active ? '▶ ' : ''}${player.name}`, 18, 94 + index * 22, 13, active ? '#f5ddaa' : '#a5b7ae');
  });

  const history = snapshot.history || [];
  history.slice(0, 4).forEach((item, index) => drawText(item, screenWidth - 18, 94 + index * 22, 11, '#8ea49b', 'right'));
  drawOwnHand(game);
  drawAction(game);
  drawText(state.notice || snapshot.message || '', screenWidth / 2, screenHeight - 222, 12, '#c8d2cc', 'center');
}

function drawOwnHand(game) {
  const hand = (game.players[state.room.playerId] && game.players[state.room.playerId].hand) || [];
  const columns = Math.ceil(hand.length / 2) || 1;
  const cardWidth = Math.max(24, Math.min(48, (screenWidth - 20) / columns));
  const startY = screenHeight - 176;
  hand.forEach((card, index) => {
    const row = index >= columns ? 1 : 0;
    const column = row ? index - columns : index;
    const x = 10 + column * cardWidth;
    const y = startY + row * 66 - (state.selected.has(card.id) ? 8 : 0);
    const selected = state.selected.has(card.id);
    roundRect(x, y, cardWidth - 2, 58, 5, selected ? '#f0d697' : '#f8f1e4', selected ? '#fff4c9' : '#b5c7bc');
    drawText(card.rank, x + (cardWidth - 2) / 2, y + 20, card.rank.length > 1 ? 11 : 14, cardColor(card), 'center');
    drawText(SUIT_SYMBOLS[card.suit] || '', x + (cardWidth - 2) / 2, y + 40, 14, cardColor(card), 'center');
    state.cards.push({ id: card.id, x, y, width: cardWidth - 2, height: 58 });
  });
}

function actionFor(game) {
  const playerId = state.room.playerId;
  if (game.phase === 'bidding' && !game.bidResponded.includes(playerId)
    && (game.forcedBidder === null || game.forcedBidder === playerId)) return 'bid';
  if (game.phase === 'exchange' && game.dealer === playerId) return 'exchange';
  if (game.phase === 'tribute' && game.currentPlayer === playerId) {
    return game.tribute && game.tribute.stage === 'offering' ? 'tribute-offer' : 'tribute-return';
  }
  if (game.phase === 'partner-call' && game.dealer === playerId) return 'call';
  if (game.phase === 'play' && game.currentPlayer === playerId) return 'play';
  if (game.phase === 'round-end' && state.snapshot.hostId === playerId) return 'next';
  return null;
}

function actionText(game, action) {
  if (!action) return `等待${currentPlayerName(game)}操作`;
  if (action === 'bid') return '提交叫庄';
  if (action === 'exchange') return '确认还牌';
  if (action === 'tribute-offer') return '确认上供';
  if (action === 'tribute-return') return '确认还牌';
  if (action === 'call') return '确认叫队友';
  if (action === 'play') return '确认出牌';
  if (action === 'next') return '开始下一局';
  return '确认';
}

function drawAction(game) {
  const action = actionFor(game);
  const y = screenHeight - 66;
  button(actionText(game, action), 18, y, screenWidth - 36, 44, action || 'noop', Boolean(action));
  if (game.phase === 'bidding' && action === 'bid') button('不争庄', screenWidth - 112, y - 54, 94, 36, 'pass');
  if (state.busy) drawText('处理中…', screenWidth / 2, y - 24, 12, '#f5ddaa', 'center');
}

function draw() {
  clearFrame();
  if (!state.snapshot) drawHome();
  else if (!state.snapshot.game) drawLobby();
  else drawGame();
}

function selectedIds() {
  return Array.from(state.selected);
}

function handleError(error) {
  state.notice = error instanceof Error ? error.message : '操作失败。';
  state.busy = false;
  draw();
}

function pollRoom() {
  if (!state.room) return;
  request(`/api/rooms/${state.room.code}`, 'GET')
    .then(snapshot => {
      if (!state.snapshot || snapshot.version >= state.snapshot.version) {
        state.snapshot = snapshot;
        state.notice = snapshot.message || '';
        draw();
      }
    })
    .catch(error => {
      state.notice = error.message;
      draw();
    })
    .finally(() => {
      if (state.room) state.pollTimer = setTimeout(pollRoom, 1200);
    });
}

function enterRoom(identity, snapshot) {
  state.room = identity;
  saveIdentity(identity);
  state.snapshot = snapshot;
  state.selected.clear();
  state.notice = snapshot.message || '';
  draw();
  if (state.pollTimer) clearTimeout(state.pollTimer);
  pollRoom();
}

function showNameDialog(title, callback) {
  wx.showModal({
    title,
    editable: true,
    placeholderText: '请输入昵称',
    success(result) {
      if (result.confirm) callback((result.content || '玩家').trim() || '玩家');
    }
  });
}

function createRoom() {
  showNameDialog('创建联网房', name => {
    state.busy = true;
    draw();
    request('/api/rooms', 'POST', { name })
      .then(response => enterRoom({ code: response.snapshot.code, token: response.token, playerId: response.playerId }, response.snapshot))
      .catch(handleError);
  });
}

function joinRoom() {
  wx.showModal({
    title: '加入联网房',
    editable: true,
    placeholderText: '请输入6位房间号',
    success(result) {
      if (!result.confirm) return;
      const code = (result.content || '').replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        state.notice = '房间号需要是6位字母或数字。';
        draw();
        return;
      }
      showNameDialog('输入昵称', name => {
        state.busy = true;
        draw();
        request(`/api/rooms/${code}/join`, 'POST', { name })
          .then(response => enterRoom({ code, token: response.token, playerId: response.playerId }, response.snapshot))
          .catch(handleError);
      });
    }
  });
}

function performAction(action) {
  if (!state.room || !state.snapshot || !state.snapshot.game || state.busy || action === 'noop') return;
  if (action === 'pass') {
    sendAction('pass', []);
    return;
  }
  sendAction(action, selectedIds());
}

function sendAction(action, cardIds) {
  state.busy = true;
  draw();
  request(`/api/rooms/${state.room.code}/action`, 'POST', { action, cardIds })
    .then(snapshot => {
      state.snapshot = snapshot;
      state.selected.clear();
      state.notice = snapshot.message || '';
      state.busy = false;
      draw();
    })
    .catch(handleError);
}

function hit(target, x, y) {
  return x >= target.x && x <= target.x + target.width && y >= target.y && y <= target.y + target.height;
}

function onTouch(event) {
  const touch = event.touches && event.touches[0];
  if (!touch || state.busy) return;
  const x = touch.clientX;
  const y = touch.clientY;
  const target = state.buttons.find(buttonItem => hit(buttonItem, x, y));
  if (target) {
    if (target.action === 'create-room') createRoom();
    else if (target.action === 'join-room') joinRoom();
    else if (target.action === 'refresh-room') pollRoom();
    else if (target.action === 'start-room') request(`/api/rooms/${state.room.code}/start`, 'POST').then(snapshot => { state.snapshot = snapshot; state.notice = snapshot.message || ''; draw(); }).catch(handleError);
    else performAction(target.action);
    return;
  }
  const card = state.cards.find(cardItem => hit(cardItem, x, y));
  if (card) {
    if (state.selected.has(card.id)) state.selected.delete(card.id);
    else state.selected.add(card.id);
    draw();
  }
}

wx.onTouchStart(onTouch);

state.room = loadIdentity();
if (state.room) {
  request(`/api/rooms/${state.room.code}`, 'GET')
    .then(snapshot => enterRoom(state.room, snapshot))
    .catch(() => { state.room = null; saveIdentity(null); draw(); });
}
draw();
