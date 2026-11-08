import { describe, expect, it, vi } from 'vitest';
import { handleRequest, type D1Database, type D1Result, type D1Statement, type WorkerEnvironment } from './worker.js';
import { createGameState } from '../game/engine.js';
import { createDeck, dealHands } from '../game/deck.js';
import { chooseBotTribute } from '../ui/bot.js';
import type { GameState, PlayerId } from '../game/types.js';

vi.mock('../game/deck.js', async importOriginal => {
  const deck = await importOriginal<typeof import('../game/deck.js')>();
  return { ...deck, shuffleCards: (cards: readonly import('../game/types.js').Card[], random: readonly number[]) => cards.length === 108 ? [...cards] : deck.shuffleCards(cards, random) };
});

type D1Value = string | number | null;

interface StoredRoom {
  data: string;
  version: number;
}

class MemoryDatabase implements D1Database {
  private readonly rooms = new Map<string, StoredRoom>();

  prepare(query: string): D1Statement {
    let values: D1Value[] = [];
    const statement: D1Statement = {
      bind: (...boundValues) => {
        values = boundValues;
        return statement;
      },
      first: async <T>() => {
        if (query.startsWith('SELECT COUNT(*)')) return { count: this.rooms.size } as T;
        const code = String(values[0]);
        const room = this.rooms.get(code);
        return room ? { data: room.data } as T : null;
      },
      run: async (): Promise<D1Result> => {
        if (query.startsWith('INSERT')) {
          const code = String(values[0]);
          if (this.rooms.has(code)) return { success: false, meta: { changes: 0 } };
          this.rooms.set(code, { data: String(values[1]), version: Number(values[2]) });
          return { success: true, meta: { changes: 1 } };
        }
        if (query.startsWith('UPDATE')) {
          const code = String(values[3]);
          const room = this.rooms.get(code);
          if (!room || room.version !== Number(values[4])) return { success: true, meta: { changes: 0 } };
          this.rooms.set(code, { data: String(values[0]), version: Number(values[1]) });
          return { success: true, meta: { changes: 1 } };
        }
        if (query.startsWith('DELETE')) {
          const code = String(values[0]);
          const room = this.rooms.get(code);
          if (!room || room.version !== Number(values[1])) return { success: true, meta: { changes: 0 } };
          this.rooms.delete(code);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: false, meta: { changes: 0 } };
      }
    };
    return statement;
  }
}

describe('persistent game worker', () => {
  it('keeps a created room readable across independent requests', async () => {
    const env: WorkerEnvironment = { DB: new MemoryDatabase() };
    const createResponse = await handleRequest(new Request('https://game.example/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '房主' })
    }), env);

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      readonly token: string;
      readonly snapshot: { readonly code: string; readonly inviteUrl: string };
    };
    expect(created.snapshot.inviteUrl).toBe(`https://game.example/?room=${created.snapshot.code}`);

    const readResponse = await handleRequest(new Request(`https://game.example/api/rooms/${created.snapshot.code}`, {
      headers: { 'x-room-token': created.token }
    }), env);
    const snapshot = await readResponse.json() as { readonly code: string; readonly players: readonly { readonly name: string }[] };

    expect(readResponse.status).toBe(200);
    expect(snapshot.code).toBe(created.snapshot.code);
    expect(snapshot.players[0]?.name).toBe('房主');
  });
});

interface Snapshot { readonly game: GameState; }
async function seedGame(env: WorkerEnvironment, game: GameState): Promise<void> {
  const room = { code: 'ABC234', hostId: 0, version: 1, message: '', history: [], game,
    players: [0, 1, 2, 3].map(id => ({ name: `玩家${id}`, token: `token-${id}` })) };
  await env.DB.prepare('INSERT INTO rooms (code, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(room.code, JSON.stringify(room), 1, 0, 0).run();
}
async function requestAs(env: WorkerEnvironment, id: PlayerId, action?: string, cardIds: readonly string[] = []): Promise<Response> {
  return handleRequest(new Request(`https://game.example/api/rooms/ABC234${action ? '/action' : ''}`, {
    method: action ? 'POST' : 'GET', headers: { 'x-room-token': `token-${id}`, 'content-type': 'application/json' },
    body: action ? JSON.stringify({ action, cardIds }) : undefined
  }), env);
}

describe('online interactive tribute', () => {
  it('requires individual submissions, filters private records, and persists the next 27-card deal', async () => {
    const env: WorkerEnvironment = { DB: new MemoryDatabase() };
    const base = createGameState(dealHands(createDeck()), 0);
    await seedGame(env, { ...base, phase: 'round-end', dealer: 0, partner: 2, winnerTeam: 0, trumpSuit: 'clubs', scores: [140, 60] });
    const started = await requestAs(env, 0, 'next');
    expect(started.status).toBe(200);
    let { game } = await started.json() as Snapshot;
    expect(game.phase).toBe('tribute');
    expect(game.tribute?.stage).toBe('offering');
    expect((await requestAs(env, 0, 'continue-next')).status).toBe(400);
    expect((await requestAs(env, 0, 'tribute-offer')).status).toBe(409);
    let steps = 0;
    while (game.phase === 'tribute' && steps < 4) {
      const player = game.currentPlayer;
      const read = await requestAs(env, player);
      game = (await read.json() as Snapshot).game;
      const cards = chooseBotTribute(game);
      const action = game.tribute?.stage === 'offering' ? 'tribute-offer' : 'tribute-return';
      const response = await requestAs(env, player, action, cards.map(card => card.id));
      expect(response.status).toBe(200);
      game = (await response.json() as Snapshot).game;
      expect(game.events?.every(event => event.viewer === null || event.viewer === player)).toBe(true);
      expect(game.tributeExchanges).toEqual([]);
      steps++;
    }
    expect(game.phase).toBe('bidding');
    const ids: string[] = [];
    for (const player of [0, 1, 2, 3] as const) {
      const snapshot = await (await requestAs(env, player)).json() as Snapshot;
      const hand = snapshot.game.players[player].hand;
      expect(hand).toHaveLength(27);
      ids.push(...hand.map(card => card.id));
      expect(snapshot.game.events?.every(event => event.viewer === null || event.viewer === player)).toBe(true);
      expect(snapshot.game.events?.some(event => event.viewer === player)).toBe(true);
    }
    expect(new Set(ids).size).toBe(108);
  });
});
