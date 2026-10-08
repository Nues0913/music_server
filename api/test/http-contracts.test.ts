import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerPlaylists } from '../src/modules/playlists/routes.js';
import { registerSongs } from '../src/modules/songs/routes.js';
import { registerUpload } from '../src/modules/uploads/routes.js';
import { PlaylistError } from '../src/modules/playlists/model.js';
import { SongError } from '../src/modules/songs/service.js';
import { UploadError } from '../src/modules/uploads/errors.js';
import type { PlaylistService } from '../src/modules/playlists/service.js';
import type { SongService } from '../src/modules/songs/service.js';
const token = 'contract-fixture-token-012345678901234567890';
const owner = '123456789012345678', id = '00000000-0000-4000-8000-000000000001';
const headers = { authorization: `Bearer ${token}`, 'x-discord-user-id': owner };

test('playlist HTTP boundary validates identity and payload, forwarding the caller revision and mapping conflicts', async t => {
  const calls: unknown[][] = [], playlist = { id, ownerId: owner, name: 'mix', revision: 3, entries: [] };
  let conflict = false;
  const service: Pick<PlaylistService, keyof PlaylistService> = {
    async list(user) { calls.push(['list', user]); return [playlist]; },
    async get() { return playlist; }, async create() { return playlist; },
    async rename(...args) { calls.push(['rename', ...args]); if (conflict) throw new PlaylistError(409, '清單已更新'); return playlist; },
    async delete(...args) { calls.push(['delete', ...args]); },
    async add() { return playlist; }, async remove() { return playlist; }, async move() { return playlist; },
  };
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.register(async scope => registerPlaylists(scope, service, token), { prefix: '/v1' }); t.after(() => app.close());
  assert.equal((await app.inject({ url: '/v1/playlists' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/playlists', headers: { ...headers, 'x-discord-user-id': 'invalid' } })).statusCode, 400);
  assert.equal(calls.length, 0);
  const list = await app.inject({ url: '/v1/playlists', headers });
  assert.equal(list.headers['cache-control'], 'no-store'); assert.equal(list.json().items[0].id, id);
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/playlists/${id}`, headers, payload: { name: 'new', revision: 2, ownerId: 'forged' } })).statusCode, 400);
  const rename = await app.inject({ method: 'PATCH', url: `/v1/playlists/${id}`, headers, payload: { name: 'new', revision: 2 } });
  assert.equal(rename.statusCode, 200); assert.deepEqual(calls.at(-1), ['rename', owner, id, 2, 'new']);
  conflict = true;
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/playlists/${id}`, headers, payload: { name: 'stale', revision: 2 } })).statusCode, 409);
  const deleted = await app.inject({ method: 'DELETE', url: `/v1/playlists/${id}`, headers, payload: { revision: 3 } });
  assert.equal(deleted.statusCode, 204); assert.equal(deleted.body, ''); assert.deepEqual(calls.at(-1), ['delete', owner, id, 3]);
  assert.equal((await app.inject({ method: 'PUT', url: `/v1/playlists/${id}/import`, headers, payload: {} })).statusCode, 404);
});

test('song boundary delegates audio bytes to Nginx and keeps validation and unexpected failures distinct', async t => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error.validation ? 400 : 503).send({ error: 'parent handler' }));
  const service: Pick<SongService, keyof SongService> = {
    async list() { throw new Error('database unavailable'); },
    async get() { throw new SongError(404, 'Song not found'); },
    async audio() { return { fileKey: 'private.wav', mimeType: 'audio/wav' }; },
  };
  app.register(async scope => registerSongs(scope, service, token), { prefix: '/v1' }); t.after(() => app.close());
  assert.equal((await app.inject({ url: '/v1/songs' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/songs?limit=26', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/songs', headers })).statusCode, 503);
  assert.equal((await app.inject({ url: `/v1/songs/${id}`, headers })).statusCode, 404);
  const audio = await app.inject({ url: `/v1/songs/${id}/audio`, headers });
  assert.equal(audio.statusCode, 200); assert.equal(audio.headers['x-accel-redirect'], '/protected-audio/private.wav');
  assert.equal(audio.body, '');
});

test('upload boundary rejects missing admin credential and exposes busy retry without reading file bytes', async t => {
  const app = Fastify(); let uploads = 0;
  await registerUpload(app, { async upload() { uploads++; throw new UploadError(409, 'busy', '5'); } },
    { adminToken: token, maxBytes: 100, minFreeBytes: 100, quotaBytes: 1000 }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/songs', payload: 'not multipart' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/songs', headers, payload: 'not multipart' })).statusCode, 415);
  const result = await app.inject({ method: 'POST', url: '/v1/songs', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=fixture' }, payload: '--fixture--\r\n' });
  assert.equal(result.statusCode, 409); assert.equal(result.headers['retry-after'], '5'); assert.equal(uploads, 1);
});
