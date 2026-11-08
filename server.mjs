import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { createDeck, dealHands, shuffleCards } from './dist/game/deck.js';
import { callPartner, createGameState, exchangeBidCards, passBid, playTurn, recordBid, resolveBidding } from './dist/game/engine.js';
import { beginTributePhase, chooseTributeCards, preservesEverySuit, splitTeamQuota, supplyCount, teamCanAntiSupply } from './dist/game/tribute.js';

const root = process.cwd();
const port = Number(process.env.PORT ?? 4174);
const advertisedHost = process.env.ROOM_HOST ?? null;
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8']
]);
const rooms = new Map();
const roomCodeCharacters = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomValues(count) {
  return Array.from({ length: count }, () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000);
}

function deal() {
  return dealHands(shuffleCards(createDeck(), randomValues(107)));
}

function shuffleArray(items) {
  const shuffled = [...items];
  const values = randomValues(Math.max(0, shuffled.length - 1));
  for (let index = shuffled.length - 1, step = 0; index > 0; index -= 1, step += 1) {
    const swapIndex = Math.floor(values[step] * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 16) : '';
  return name || '玩家';
}

function createRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = Array.from({ length: 6 }, () => roomCodeCharacters[randomInt(roomCodeCharacters.length)]).join('');
    if (!rooms.has(code)) return code;
  }
  throw new Error('暂时无法生成房间号，请稍后重试。');
}

function lanAddress() {
  const interfaces = Object.entries(networkInterfaces());
  const isVirtual = (name) => /virtual|vmware|vbox|hyper-v|wsl|loopback/i.test(name);
  const preferred = interfaces.filter(([name]) => !isVirtual(name) && /wlan|wi-?fi|ethernet|以太网/i.test(name));
  const candidates = [...preferred, ...interfaces.filter(([name]) => !preferred.some(([preferredName]) => preferredName === name) && !isVirtual(name))];
  for (const [, addresses] of candidates) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function inviteUrl(code) {
  return `http://${advertisedHost ?? lanAddress()}:${port}/?room=${code}`;
}

function publicPlayers(room) {
  return room.players.map((player, id) => player
    ? { id, name: player.name, ready: true }
    : { id, name: `等待玩家${id + 1}`, ready: false });
}

function hiddenCards(count, playerId) {
  return Array.from({ length: count }, (_, index) => ({
    id: `hidden-${playerId}-${index}`,
    suit: 'clubs',
    rank: '4',
    copy: index % 2 === 0 ? 1 : 2
  }));
}

function roomSnapshot(room, playerId) {
  let game = null;
  if (room.game) {
    game = {
      ...room.game,
      bids: room.game.bidsRevealed ? room.game.bids : [],
      players: room.game.players.map(player => ({
        ...player,
        hand: player.id === playerId || room.game.phase === 'round-end'
          ? player.hand
          : hiddenCards(player.hand.length, player.id)
      }))
    };
  }
  return {
    code: room.code,
    hostId: room.hostId,
    playerId,
    inviteUrl: inviteUrl(room.code),
    status: room.game ? room.game.phase === 'round-end' ? 'finished' : 'playing' : 'waiting',
    version: room.version,
    players: publicPlayers(room),
    game,
    message: room.message,
    history: [...room.history]
  };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function fail(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求格式无效。');
  }
}

function bumpRoom(room, message) {
  room.version += 1;
  room.message = message;
  room.history = [message, ...room.history].slice(0, 20);
}

function getRoom(code) {
  const room = rooms.get(code.toUpperCase());
  if (!room) throw Object.assign(new Error('没有找到这个房间，请检查房间号。'), { statusCode: 404 });
  return room;
}

function getRoomPlayer(request, room) {
  const token = request.headers['x-room-token'];
  if (typeof token !== 'string') throw Object.assign(new Error('房间身份已失效，请重新加入。'), { statusCode: 401 });
  const playerId = room.players.findIndex(player => player?.token === token);
  if (playerId < 0) throw Object.assign(new Error('房间身份已失效，请重新加入。'), { statusCode: 401 });
  return playerId;
}

function cardsForPlayer(game, playerId, ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('请选择有效的手牌。');
  const hand = game.players[playerId].hand;
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error('同一张牌不能重复选择。');
  const cards = ids.map(id => hand.find(card => card.id === id));
  if (cards.some(card => card === undefined)) throw new Error('只能选择自己手中的牌。');
  return cards;
}

function roomPlayerName(room, playerId) {
  return room.players[playerId]?.name ?? `玩家${playerId + 1}`;
}

function advanceBidding(room, next, playerId) {
  if (next.bidTurn !== 4) return { game: next, message: `${roomPlayerName(room, playerId)}完成争庄。` };
  const resolved = resolveBidding(next);
  if (resolved.forcedBidder !== null) {
    return { game: resolved, message: `无人主动叫庄，由${roomPlayerName(room, resolved.forcedBidder)}强制叫庄。` };
  }
  if (resolved.dealer === null) return { game: resolved, message: '四家没有有效叫庄牌，需要重新发牌。' };
  return { game: resolved, message: `争庄揭晓，${roomPlayerName(room, resolved.dealer)}成为庄家。` };
}

function beginNextRoundTribute(game) {
  if (game.winnerTeam === null || game.dealer === null || game.partner === null || game.trumpSuit === null) {
    const previousDealer = game.dealer ?? game.previousDealer;
    const freshState = createGameState(deal(), previousDealer);
    const tributeState = beginTributePhase({ ...game, fullSupply: false, previousLosingTeam: null }, freshState.players, []);
    return { game: tributeState, message: '本轮无需上供，请查看明细后开始下一局。' };
  }
  const previousDealer = game.dealer;
  const otherPlayers = [0, 1, 2, 3].filter(id => id !== game.dealer && id !== game.partner);
  const winningTeam = game.winnerTeam === 0 ? [game.dealer, game.partner] : otherPlayers;
  const losingTeam = game.winnerTeam === 0 ? otherPlayers : [game.dealer, game.partner];
  const requested = supplyCount(Math.abs(game.scores[0] - game.scores[1]));
  const newHands = deal();
  const temporaryPlayers = newHands.map((hand, id) => ({ id, hand }));
  let dealState = { ...game, phase: 'dealing', players: temporaryPlayers };
  let message = requested === 0 ? '净胜不足20分，本轮不上供。' : `按净胜分计算上${requested}供。`;
  const antiSupply = requested === 8 && teamCanAntiSupply(dealState, losingTeam, game.trumpSuit);
  const fullSupply = requested === 8 && !antiSupply;
  let tributeExchanges = [];
  if (antiSupply) {
    message = '输家成功抗满供，本轮不上供。';
  } else if (requested > 0) {
    const loserQuotas = splitTeamQuota(requested, losingTeam, previousDealer);
    const offers = new Map([
      [losingTeam[0], chooseTributeCards(dealState.players[losingTeam[0]].hand, loserQuotas[0], game.trumpSuit)],
      [losingTeam[1], chooseTributeCards(dealState.players[losingTeam[1]].hand, loserQuotas[1], game.trumpSuit)]
    ]);
    const slots = shuffleArray(losingTeam.flatMap(loser => (offers.get(loser) ?? []).map(card => ({ loser, card }))));
    if (slots.length) {
      const winnerQuotas = splitTeamQuota(slots.length, winningTeam, previousDealer);
      const winnerSlots = new Map([[winningTeam[0], []], [winningTeam[1], []]]);
      let cursor = 0;
      for (const winner of winningTeam) {
        const quota = winner === winningTeam[0] ? winnerQuotas[0] : winnerQuotas[1];
        winnerSlots.set(winner, slots.slice(cursor, cursor + quota));
        cursor += quota;
      }
      const exchanges = new Map();
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
      message = `已完成${slots.length}供：输家上牌，赢家分供并还牌。请查看明细。`;
    } else {
      message = '输家没有足够的合格主牌，本轮未能上供。';
    }
  }
  const tributeState = beginTributePhase(
    { ...game, fullSupply, previousLosingTeam: fullSupply ? losingTeam : null },
    temporaryPlayers,
    tributeExchanges
  );
  return { game: tributeState, message };
}

function continueAfterTribute(game) {
  if (game.phase !== 'tribute') throw Object.assign(new Error('当前没有待确认的上供结果。'), { statusCode: 409 });
  const hands = game.players.map(player => player.hand);
  return createGameState(hands, game.dealer ?? game.previousDealer, {
    fullSupply: game.fullSupply,
    previousLosingTeam: game.previousLosingTeam
  });
}

function randomReturnCards(hand, count) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const shuffled = shuffleCards(hand, randomValues(Math.max(0, hand.length - 1)));
    const candidate = shuffled.slice(0, count);
    if (preservesEverySuit(hand, candidate)) return candidate;
  }
  throw new Error('无法随机选出符合花色保留规则的还牌。');
}

function applyAction(room, playerId, body) {
  const game = room.game;
  if (!game) throw Object.assign(new Error('房间尚未开始游戏。'), { statusCode: 409 });
  const action = body.action;
  if (action === 'next') {
    if (playerId !== room.hostId || game.phase !== 'round-end') throw Object.assign(new Error('只有房主可以开始下一局。'), { statusCode: 403 });
    const result = beginNextRoundTribute(game);
    room.game = result.game;
    bumpRoom(room, result.message);
    return;
  }
  if (action === 'continue-next') {
    if (playerId !== room.hostId || game.phase !== 'tribute') throw Object.assign(new Error('只有房主可以确认上供结果。'), { statusCode: 403 });
    room.game = continueAfterTribute(game);
    bumpRoom(room, '上供还牌确认完成，新一局已发牌。');
    return;
  }
  if (action === 'redeal') {
    if (playerId !== room.hostId || game.phase !== 'dealing') throw Object.assign(new Error('当前不能重新发牌。'), { statusCode: 403 });
    room.game = createGameState(deal(), game.dealer ?? game.previousDealer);
    bumpRoom(room, '已重新发牌。');
    return;
  }
  const racingBid = game.phase === 'bidding' && (action === 'bid' || action === 'pass');
  if (!racingBid && game.currentPlayer !== playerId) throw Object.assign(new Error('还没有轮到你操作。'), { statusCode: 409 });
  const cards = cardsForPlayer(game, playerId, body.cardIds ?? []);
  let next = game;
  let message = '';
  if (action === 'bid') {
    next = recordBid(game, cards, playerId);
    if (next.bidTurn === 4) {
      const result = advanceBidding(room, next, playerId);
      next = result.game;
      message = result.message;
    } else message = `${roomPlayerName(room, playerId)}提交争庄牌。`;
  } else if (action === 'pass') {
    next = passBid(game, playerId);
    if (next.bidTurn === 4) {
      const result = advanceBidding(room, next, playerId);
      next = result.game;
      message = result.message;
    } else message = `${roomPlayerName(room, playerId)}选择不争庄。`;
  } else if (action === 'exchange') {
    next = exchangeBidCards(game, cards);
    message = '庄家已完成还牌。';
  } else if (action === 'call') {
    if (!cards[0] || cards.length !== 1) throw new Error('请选择一张叫队友的牌。');
    next = callPartner(game, cards[0]);
    message = '庄家已叫出队友，开始出牌。';
  } else if (action === 'play') {
    next = playTurn(game, playerId, cards);
    message = next.phase === 'round-end'
      ? '本局结束。'
      : next.currentTrick.length === 0 ? `玩家${next.currentPlayer + 1}赢下本墩并领出。` : `玩家${playerId + 1}完成出牌。`;
  } else {
    throw Object.assign(new Error('不支持这个操作。'), { statusCode: 400 });
  }
  room.game = next;
  bumpRoom(room, message);
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'rooms' && request.method === 'POST') {
    const body = await readJson(request);
    if (rooms.size >= 1000) return fail(response, 503, '房间数量已满，请稍后重试。');
    const code = createRoomCode();
    const token = randomUUID();
    const room = {
      code,
      hostId: 0,
      players: [{ name: cleanName(body.name), token }, null, null, null],
      game: null,
      version: 1,
      message: '房间已创建，等待其他玩家加入。',
      history: ['房间已创建。']
    };
    rooms.set(code, room);
    return sendJson(response, 201, { token, playerId: 0, snapshot: roomSnapshot(room, 0) });
  }
  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) return fail(response, 404, '没有找到这个接口。');
  let room;
  try {
    room = getRoom(parts[2]);
  } catch (error) {
    return fail(response, error.statusCode ?? 400, error.message);
  }
  const operation = parts[3];
  if (operation === 'join' && request.method === 'POST') {
    const body = await readJson(request);
    if (room.game) return fail(response, 409, '这间房已经开局，暂时不能加入。');
    const playerId = room.players.findIndex(player => player === null);
    if (playerId < 0) return fail(response, 409, '房间已满。');
    const token = randomUUID();
    room.players[playerId] = { name: cleanName(body.name), token };
    bumpRoom(room, `${cleanName(body.name)}加入了房间。`);
    return sendJson(response, 201, { token, playerId, snapshot: roomSnapshot(room, playerId) });
  }
  let playerId;
  try {
    playerId = getRoomPlayer(request, room);
  } catch (error) {
    return fail(response, error.statusCode ?? 401, error.message);
  }
  if (request.method === 'GET' && !operation) return sendJson(response, 200, roomSnapshot(room, playerId));
  if (operation === 'name' && request.method === 'POST') {
    const body = await readJson(request);
    room.players[playerId].name = cleanName(body.name);
    bumpRoom(room, `${room.players[playerId].name}修改了昵称。`);
    return sendJson(response, 200, roomSnapshot(room, playerId));
  }
  if (operation === 'leave' && request.method === 'POST') {
    if (room.game) return fail(response, 409, '牌局开始后暂时不能离开房间。');
    room.players[playerId] = null;
    if (room.players.every(player => player === null)) {
      rooms.delete(room.code);
      return sendJson(response, 200, { left: true });
    }
    if (room.hostId === playerId) room.hostId = room.players.findIndex(player => player !== null);
    bumpRoom(room, '一位玩家离开了房间。');
    return sendJson(response, 200, { left: true });
  }
  if (operation === 'start' && request.method === 'POST') {
    if (playerId !== room.hostId) return fail(response, 403, '只有房主可以开始游戏。');
    if (room.game) return fail(response, 409, '牌局已经开始。');
    if (room.players.some(player => player === null)) return fail(response, 409, '四个座位都有人后才能开始。');
    room.game = createGameState(deal(), 0);
    bumpRoom(room, '四位玩家已到齐，开始发牌。');
    return sendJson(response, 200, roomSnapshot(room, playerId));
  }
  if (operation === 'action' && request.method === 'POST') {
    const body = await readJson(request);
    try {
      applyAction(room, playerId, body);
    } catch (error) {
      return fail(response, error.statusCode ?? 400, error.message);
    }
    return sendJson(response, 200, roomSnapshot(room, playerId));
  }
  return fail(response, 404, '没有找到这个接口。');
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end('Method Not Allowed');
      return;
    }
    const pathname = url.pathname;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': contentTypes.get(extname(file)) ?? 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error instanceof Error && error.message === '请求内容过大。') return fail(response, 413, error.message);
    if (error instanceof Error && error.message === '请求格式无效。') return fail(response, 400, error.message);
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found. Run npm run build first.');
  }
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`新疆双扣 running at http://127.0.0.1:${port} (room link host ${advertisedHost ?? lanAddress()})\n`);
});
