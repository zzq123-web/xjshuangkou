import { createDeck, dealHands, shuffleCards } from '../game/deck.js';
import { callPartner, collectBidCards, createGameState, exchangeBidCards, passBid, playTurn, recordBid, resolveBidding, resumeAfterTribute } from '../game/engine.js';
import { beginInteractiveTribute, submitTributeOffer, submitTributeReturn } from '../game/tribute.js';
import { gameForPlayer } from '../game/view.js';
import type { Card, GameState, PlayerId } from '../game/types.js';
import page from './page.js';
import { assets } from './assets.js';

type D1Value = string | number | null;

export interface D1Result {
  readonly meta?: { readonly changes?: number };
  readonly success?: boolean;
}

export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
}

export interface WorkerEnvironment {
  readonly DB: D1Database;
}

interface RoomPlayer {
  name: string;
  readonly token: string;
}

interface Room {
  readonly code: string;
  hostId: PlayerId;
  readonly players: [RoomPlayer | null, RoomPlayer | null, RoomPlayer | null, RoomPlayer | null];
  game: GameState | null;
  version: number;
  message: string;
  history: string[];
}

interface RoomRow {
  readonly data: string;
}

interface CountRow {
  readonly count: number;
}

interface ApiBody {
  readonly name?: unknown;
  readonly action?: unknown;
  readonly cardIds?: unknown;
}

const roomCodeCharacters = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function randomValues(count: number): number[] {
  const values = new Uint32Array(count);
  crypto.getRandomValues(values);
  return Array.from(values, value => value / 0x1_0000_0000);
}

function deal() {
  return dealHands(shuffleCards(createDeck(), randomValues(107)));
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 16) : '';
  return name || '玩家';
}

function createRoomCode(): string {
  const values = randomValues(6);
  return Array.from(values, value => roomCodeCharacters[Math.floor(value * roomCodeCharacters.length)]).join('');
}

function publicPlayers(room: Room) {
  return room.players.map((player, id) => player
    ? { id, name: player.name, ready: true }
    : { id, name: `等待玩家${id + 1}`, ready: false });
}

function roomSnapshot(room: Room, playerId: PlayerId, requestUrl: string) {
  const game = room.game ? gameForPlayer(room.game, playerId) : null;
  const invite = new URL(`/?room=${room.code}`, requestUrl);
  return {
    code: room.code,
    hostId: room.hostId,
    playerId,
    inviteUrl: invite.toString(),
    status: room.game ? room.game.phase === 'round-end' ? 'finished' : 'playing' : 'waiting',
    version: room.version,
    players: publicPlayers(room),
    game,
    message: room.message,
    history: [...room.history]
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function readJson(request: Request): Promise<ApiBody> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 32_768) throw new HttpError(413, '请求内容过大。');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > 32_768) {
      await reader.cancel();
      throw new HttpError(413, '请求内容过大。');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid body');
    return parsed as ApiBody;
  } catch {
    throw new HttpError(400, '请求格式无效。');
  }
}

async function getRoom(db: D1Database, code: string): Promise<Room> {
  const row = await db.prepare('SELECT data FROM rooms WHERE code = ?').bind(code.toUpperCase()).first<RoomRow>();
  if (!row) throw new HttpError(404, '没有找到这个房间，请检查房间号。');
  const room = JSON.parse(row.data) as Room;
  if (room.game?.phase === 'exchange') room.game = collectBidCards(room.game);
  return room;
}

async function saveRoom(db: D1Database, room: Room, expectedVersion: number): Promise<boolean> {
  const result = await db.prepare('UPDATE rooms SET data = ?, version = ?, updated_at = ? WHERE code = ? AND version = ?')
    .bind(JSON.stringify(room), room.version, Date.now(), room.code, expectedVersion)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

async function removeRoom(db: D1Database, code: string, expectedVersion: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM rooms WHERE code = ? AND version = ?').bind(code, expectedVersion).run();
  return (result.meta?.changes ?? 0) === 1;
}

function getRoomPlayer(request: Request, room: Room): PlayerId {
  const token = request.headers.get('x-room-token');
  if (!token) throw new HttpError(401, '房间身份已失效，请重新加入。');
  const playerId = room.players.findIndex(player => player?.token === token);
  if (playerId < 0) throw new HttpError(401, '房间身份已失效，请重新加入。');
  return playerId as PlayerId;
}

function cardsForPlayer(game: GameState, playerId: PlayerId, ids: unknown): Card[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('请选择有效的手牌。');
  const cardIds = ids as string[];
  const hand = game.players[playerId].hand;
  const uniqueIds = new Set(cardIds);
  if (uniqueIds.size !== cardIds.length) throw new Error('同一张牌不能重复选择。');
  const cards = cardIds.map(id => hand.find(card => card.id === id));
  if (cards.some(card => card === undefined)) throw new Error('只能选择自己手中的牌。');
  return cards.filter((card): card is Card => card !== undefined);
}

function roomPlayerName(room: Room, playerId: PlayerId): string {
  return room.players[playerId]?.name ?? `玩家${playerId + 1}`;
}

function bumpRoom(room: Room, message: string): void {
  room.version += 1;
  room.message = message;
  room.history = [message, ...room.history].slice(0, 20);
}

function advanceBidding(room: Room, next: GameState, playerId: PlayerId): { game: GameState; message: string } {
  if (next.bidTurn !== 4) return { game: next, message: `${roomPlayerName(room, playerId)}完成争庄。` };
  const resolved = resolveBidding(next);
  if (resolved.forcedBidder !== null) {
    return { game: resolved, message: `无人主动叫庄，由${roomPlayerName(room, resolved.forcedBidder)}强制叫庄。` };
  }
  if (resolved.dealer === null) return { game: resolved, message: '四家没有有效叫庄牌，需要重新发牌。' };
  return { game: resolved, message: `争庄揭晓，${roomPlayerName(room, resolved.dealer)}成为庄家。` };
}

function finishTribute(game: GameState): GameState {
  return game.phase === 'tribute' && game.tribute?.stage === 'complete' ? resumeAfterTribute(game) : game;
}

function applyAction(room: Room, playerId: PlayerId, body: ApiBody): void {
  const game = room.game;
  if (!game) throw new HttpError(409, '房间尚未开始游戏。');
  const action = body.action;
  if (action === 'next') {
    if (playerId !== room.hostId || game.phase !== 'round-end') throw new HttpError(403, '只有房主可以开始下一局。');
    const dealtPlayers = createGameState(deal(), game.dealer ?? game.previousDealer).players;
    room.game = finishTribute(beginInteractiveTribute(game, dealtPlayers));
    bumpRoom(room, room.game.phase === 'tribute' ? '新牌已发，等待输家选择供牌。' : '本轮无需上供，开始新一局。');
    return;
  }
  if (action === 'continue-next') {
    if (playerId !== room.hostId || game.phase !== 'tribute') throw new HttpError(403, '只有房主可以确认上供结果。');
    room.game = resumeAfterTribute(game);
    bumpRoom(room, '上供还牌确认完成，新一局已发牌。');
    return;
  }
  if (action === 'redeal') {
    if (playerId !== room.hostId || game.phase !== 'dealing') throw new HttpError(403, '当前不能重新发牌。');
    room.game = createGameState(deal(), game.dealer ?? game.previousDealer);
    bumpRoom(room, '已重新发牌。');
    return;
  }
  const racingBid = game.phase === 'bidding' && (action === 'bid' || action === 'pass');
  if (!racingBid && game.currentPlayer !== playerId) throw new HttpError(409, '还没有轮到你操作。');
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
  } else if (action === 'tribute-offer') {
    next = finishTribute(submitTributeOffer(game, playerId, cards, randomValues(107)));
    message = next.phase === 'bidding' ? '上供还牌完成，开始新一局。' : next.tribute?.stage === 'returning' ? '供牌已随机分配，请赢家选择还牌。' : '已提交供牌，等待另一位输家。';
  } else if (action === 'tribute-return') {
    next = finishTribute(submitTributeReturn(game, playerId, cards, randomValues(107)));
    message = next.phase === 'bidding' ? '还牌已随机分配，每人27张，开始新一局。' : '已提交还牌，等待另一位赢家。';
  } else if (action === 'exchange') {
    next = exchangeBidCards(game, cards, randomValues(107));
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
    throw new HttpError(400, '不支持这个操作。');
  }
  room.game = next;
  bumpRoom(room, message);
}

async function handleRoomApi(request: Request, env: WorkerEnvironment, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'rooms' && request.method === 'POST') {
    const body = await readJson(request);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM rooms').first<CountRow>();
    if ((count?.count ?? 0) >= 1000) return fail(503, '房间数量已满，请稍后重试。');
    const code = createRoomCode();
    const token = crypto.randomUUID();
    const room: Room = {
      code,
      hostId: 0,
      players: [{ name: cleanName(body.name), token }, null, null, null],
      game: null,
      version: 1,
      message: '房间已创建，等待其他玩家加入。',
      history: ['房间已创建。']
    };
    const inserted = await env.DB.prepare('INSERT INTO rooms (code, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(code, JSON.stringify(room), room.version, Date.now(), Date.now())
      .run();
    if (!inserted.success) return fail(503, '创建房间失败，请重试。');
    return json({ token, playerId: 0, snapshot: roomSnapshot(room, 0, url.toString()) }, 201);
  }
  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) return fail(404, '没有找到这个接口。');
  let room: Room;
  try {
    room = await getRoom(env.DB, parts[2]);
  } catch (error) {
    return fail(error instanceof HttpError ? error.statusCode : 500, error instanceof Error ? error.message : '房间读取失败。');
  }
  const operation = parts[3];
  if (operation === 'join' && request.method === 'POST') {
    const body = await readJson(request);
    if (room.game) return fail(409, '这间房已经开局，暂时不能加入。');
    const expectedVersion = room.version;
    const playerId = room.players.findIndex(player => player === null);
    if (playerId < 0) return fail(409, '房间已满。');
    const id = playerId as PlayerId;
    const name = cleanName(body.name);
    const token = crypto.randomUUID();
    room.players[id] = { name, token };
    bumpRoom(room, `${name}加入了房间。`);
    if (!await saveRoom(env.DB, room, expectedVersion)) return fail(409, '房间刚刚有其他玩家加入，请刷新后重试。');
    return json({ token, playerId: id, snapshot: roomSnapshot(room, id, url.toString()) }, 201);
  }
  let playerId: PlayerId;
  try {
    playerId = getRoomPlayer(request, room);
  } catch (error) {
    return fail(error instanceof HttpError ? error.statusCode : 401, error instanceof Error ? error.message : '房间身份已失效，请重新加入。');
  }
  if (request.method === 'GET' && !operation) return json(roomSnapshot(room, playerId, url.toString()));
  const expectedVersion = room.version;
  if (operation === 'name' && request.method === 'POST') {
    const body = await readJson(request);
    const player = room.players[playerId];
    if (!player) return fail(401, '房间身份已失效，请重新加入。');
    player.name = cleanName(body.name);
    bumpRoom(room, `${player.name}修改了昵称。`);
  } else if (operation === 'leave' && request.method === 'POST') {
    if (room.game) return fail(409, '牌局开始后暂时不能离开房间。');
    room.players[playerId] = null;
    if (room.players.every(player => player === null)) {
      if (!await removeRoom(env.DB, room.code, expectedVersion)) return fail(409, '房间状态已更新，请重试。');
      return json({ left: true });
    }
    if (room.hostId === playerId) room.hostId = room.players.findIndex(player => player !== null) as PlayerId;
    bumpRoom(room, '一位玩家离开了房间。');
    if (!await saveRoom(env.DB, room, expectedVersion)) return fail(409, '房间状态已更新，请重试。');
    return json({ left: true });
  } else if (operation === 'start' && request.method === 'POST') {
    if (playerId !== room.hostId) return fail(403, '只有房主可以开始游戏。');
    if (room.game) return fail(409, '牌局已经开始。');
    if (room.players.some(player => player === null)) return fail(409, '四个座位都有人后才能开始。');
    room.game = createGameState(deal(), 0);
    bumpRoom(room, '四位玩家已到齐，开始发牌。');
  } else if (operation === 'action' && request.method === 'POST') {
    const body = await readJson(request);
    try {
      applyAction(room, playerId, body);
    } catch (error) {
      return fail(error instanceof HttpError ? error.statusCode : 400, error instanceof Error ? error.message : '操作无效。');
    }
  } else {
    return fail(404, '没有找到这个接口。');
  }
  if (!await saveRoom(env.DB, room, expectedVersion)) return fail(409, '房间状态已更新，请刷新后重试。');
  return json(roomSnapshot(room, playerId, url.toString()));
}

export async function handleRequest(request: Request, env: WorkerEnvironment): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith('/api/')) return await handleRoomApi(request, env, url);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname === '/') return new Response(request.method === 'HEAD' ? null : page, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
      });
      const asset = assets[url.pathname.slice(1)];
      if (asset !== undefined) {
        return new Response(request.method === 'HEAD' ? null : asset, {
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }
        });
      }
    }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } catch (error) {
    if (error instanceof HttpError) return fail(error.statusCode, error.message);
    return fail(500, '服务器暂时不可用，请稍后重试。');
  }
}

export default { fetch: handleRequest };
