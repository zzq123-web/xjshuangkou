import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalGame } from './server.mjs';
import { handleRequest } from './src/server/worker.ts';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local server storage adapter', () => {
  it('uses the hosted room API and survives closing and reopening the database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shuangkou-test-'));
    directories.push(directory);
    const filename = join(directory, 'rooms.sqlite');
    const first = openLocalGame(handleRequest, filename);
    let identity;
    try {
      const response = await first.fetch(new Request('http://localhost/api/rooms', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '本机玩家' })
      }));
      expect(response.status).toBe(201);
      identity = await response.json();
    } finally { first.close(); }
    const reopened = openLocalGame(handleRequest, filename);
    try {
      const response = await reopened.fetch(new Request(`http://localhost/api/rooms/${identity.snapshot.code}`, {
        headers: { 'x-room-token': identity.token }
      }));
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot.players[0].name).toBe('本机玩家');
      expect(snapshot.code).toBe(identity.snapshot.code);
    } finally { reopened.close(); }
  });
});
