import { describe, expect, it } from 'vitest';
import { handleRequest, type D1Database, type D1Result, type D1Statement, type WorkerEnvironment } from './worker.js';

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
