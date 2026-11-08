import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Node entrypoint and hosted Worker share the exact same room API. */
export function openLocalGame(handler, databasePath = ':memory:') {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'").get()) {
    database.exec(readFileSync(new URL('./drizzle/0000_rooms.sql', import.meta.url), 'utf8'));
  }
  const DB = {
    prepare(sql) {
      const query = database.prepare(sql);
      let parameters = [];
      const statement = {
        bind(...values) { parameters = values; return statement; },
        async first() { return query.get(...parameters) ?? null; },
        async run() {
          const result = query.run(...parameters);
          return { success: true, meta: { changes: Number(result.changes) } };
        }
      };
      return statement;
    }
  };
  return { fetch: request => handler(request, { DB }), close: () => database.close() };
}

function lanAddress() {
  const interfaces = Object.entries(networkInterfaces()).filter(([name]) => !/virtual|vmware|vbox|hyper-v|wsl|loopback/i.test(name));
  interfaces.sort(([a], [b]) => Number(/wlan|wi-?fi|ethernet|以太网/i.test(b)) - Number(/wlan|wi-?fi|ethernet|以太网/i.test(a)));
  for (const [, addresses] of interfaces) {
    for (const address of addresses ?? []) if (address.family === 'IPv4' && !address.internal) return address.address;
  }
  return '127.0.0.1';
}

export async function startLocalServer() {
  const { default: worker } = await import('./dist/server/index.js');
  const port = Number(process.env.PORT ?? 4174);
  const advertisedHost = process.env.ROOM_HOST ?? lanAddress();
  const databasePath = process.env.ROOM_DB ?? fileURLToPath(new URL('./outputs/local-rooms.sqlite', import.meta.url));
  const game = openLocalGame(worker.fetch, databasePath);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 32_768) {
          outgoing.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
          outgoing.end(JSON.stringify({ error: '请求内容过大。' }));
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      const method = incoming.method ?? 'GET';
      const url = new URL(incoming.url ?? '/', `http://${advertisedHost}:${port}`);
      const request = new Request(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) });
      const response = await game.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Local server error'}\n`);
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      outgoing.end(JSON.stringify({ error: '服务器暂时不可用，请稍后重试。' }));
    }
  });
  server.on('close', game.close);
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`新疆双扣 http://127.0.0.1:${port} · 局域网 http://${advertisedHost}:${port}\n`);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startLocalServer();
