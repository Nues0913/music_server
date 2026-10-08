import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { buildApp } from '../src/app.js';
import { registerPlaylists } from '../src/modules/playlists/routes.js';
import { registerSongs } from '../src/modules/songs/routes.js';
import { registerUpload } from '../src/modules/uploads/routes.js';
import { createEntries, PlaylistError } from '../src/modules/playlists/model.js';
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

test('playlist reads preserve saved references and revision even when the song audio directory is unavailable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'playlist-availability-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioRoot = join(directory, 'unavailable-audio-directory');
  await writeFile(audioRoot, 'A regular file cannot serve as an audio directory.');
  const songId = '00000000-0000-4000-8000-000000000002';
  const local = { source: 'local' as const, id: 'missing-bot-local-file', title: 'Saved local song' };
  const remote = { source: 'remote' as const, id: songId, title: 'Saved remote song', library: 'https://music.example/' };
  const tracks = [local, remote, local];
  const row = { id, ownerId: owner, name: 'saved mix', nameKey: 'saved mix', revision: 7,
    entries: createEntries(tracks).map(entry => ({ ...entry, playlistId: id,
      artist: entry.artist ?? null, library: entry.library ?? null })) };
  const snapshot = structuredClone(row);
  // Inject stored rows, while exercising the real app, services and filesystem check.
  // This read contract does not stand in for the native Prisma transaction tests.
  const db = {
    playlist: { async findFirst() { return row; }, async findMany() { return [row]; } },
    song: { async findFirst() { return { id: songId, fileKey: `${songId}.wav`, mimeType: 'audio/wav', byteSize: 100 }; } },
  } as unknown as PrismaClient;
  const app = buildApp({ db, token, audioRoot });
  t.after(() => app.close());
  const audio = await app.inject({ url: `/v1/songs/${songId}/audio`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(audio.statusCode, 404);
  assert.deepEqual(audio.json(), { error: 'Audio unavailable' });
  const expectedEntries = tracks.map((track, index) => ({ ...track, entryId: row.entries[index]!.entryId }));
  const get = await app.inject({ url: `/v1/playlists/${id}`, headers });
  assert.equal(get.statusCode, 200); assert.equal(get.json().revision, 7);
  assert.deepEqual(get.json().entries, expectedEntries);
  const list = await app.inject({ url: '/v1/playlists', headers });
  assert.equal(list.statusCode, 200); assert.deepEqual(list.json().items, [get.json()]);
  assert.deepEqual(row, snapshot);
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
