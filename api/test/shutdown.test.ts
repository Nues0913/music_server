import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { registerShutdown } from '../src/infrastructure/shutdown.js';

test('shutdown drains an active HTTP request before disconnecting the database and rejects later requests', { timeout: 10000 }, async t => {
  const signals = new EventEmitter(), events: string[] = [];
  let started!: () => void, release!: () => void, disconnects = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const db = {
    song: { async findMany() {
      assert.equal(disconnects, 0); events.push('request started'); started();
      await gate;
      assert.equal(disconnects, 0); events.push('request completed'); return [];
    } },
    async $disconnect() { disconnects++; events.push('database disconnected'); },
  };
  const token = 'shutdown-fixture-token-012345678901234567890';
  const app = buildApp({ db: db as unknown as PrismaClient, token, audioRoot: '/unused-fixture' });
  const stop = registerShutdown(app, db, signals);
  const close = t.mock.method(app, 'close');
  t.after(async () => { release(); await stop(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  // A real socket is required: app.inject does not exercise HTTP connection draining.
  const request = fetch(`${address}/v1/songs`, { headers: { authorization: `Bearer ${token}` } });
  await ready;
  const stopped = stop();
  assert.equal(stop(), stopped);
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  assert.equal(close.mock.callCount(), 1);
  assert.equal(disconnects, 0);
  release();
  const response = await request;
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { items: [], nextCursor: null });
  await stopped;
  assert.deepEqual(events, ['request started', 'request completed', 'database disconnected']);
  assert.equal(disconnects, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
  await assert.rejects(app.inject({ url: '/v1/songs', headers: { authorization: `Bearer ${token}` } }));
  assert.equal(events.length, 3);
});

test('failed database disconnect rejects the shared stop promise and still removes signal listeners', async t => {
  const signals = new EventEmitter();
  let disconnects = 0;
  const db = { async $disconnect() { disconnects++; throw new Error('fixture disconnect failure'); } };
  const app = buildApp({ db: db as unknown as PrismaClient, token: 'shutdown-fixture-token', audioRoot: '/unused-fixture' });
  const stop = registerShutdown(app, db, signals);
  t.after(() => stop().catch(() => {}));
  await app.ready();
  const stopped = stop();
  assert.equal(stop(), stopped);
  await assert.rejects(stopped, /fixture disconnect failure/);
  assert.equal(disconnects, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});
