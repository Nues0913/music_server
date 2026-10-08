import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, cp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { connectDatabase } from '../src/db.js';
import { playlistBotToken } from '../src/config.js';
const token = 'playback-fixture-token-012345678901234567890';
const botToken = 'playlist-fixture-token-012345678901234567890';
const user = '123456789012345678', other = '223456789012345678';
const headers = (owner = user) => ({ authorization: `Bearer ${botToken}`, 'x-discord-user-id': owner });
const local = { source: 'local', id: 'local-track-id', title: '本地歌曲' };
const remote = { source: 'remote', id: '00000000-0000-4000-8000-000000000001', title: '遠端歌曲', library: 'https://music.example/' };
let root: string, db: PrismaClient, app: ReturnType<typeof buildApp>;
let databaseUrl: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'playlist-api-test-'));
  databaseUrl = `file:${join(root, 'db.sqlite')}?connection_limit=1`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'info' }, stdio: 'pipe' });
  db = await connectDatabase(databaseUrl);
  app = buildApp({ db, token, playlistToken: botToken, audioRoot: root });
});
after(async () => { if (app) await app.close(); if (db) await db.$disconnect(); if (root) await rm(root, { recursive: true, force: true }); });
async function create(name: string, owner = user, tracks: object[] = []) {
  const result = await app.inject({ method: 'POST', url: '/v1/playlists', headers: headers(owner), payload: { name, tracks } });
  assert.equal(result.statusCode, 201, result.body); return result.json();
}
test('only the dedicated trusted Bot credential accepts a Discord identity', async () => {
  for (const h of [{}, { authorization: `Bearer ${token}`, 'x-discord-user-id': user }, { authorization: 'Bearer wrong', 'x-discord-user-id': user }]) {
    assert.equal((await app.inject({ url: '/v1/playlists', headers: h })).statusCode, 401);
  }
  for (const id of ['', 'alice', '../123', '1']) assert.equal((await app.inject({ url: '/v1/playlists', headers: headers(id) })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/playlists', headers: headers() })).statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/songs', headers: headers() })).statusCode, 401);
  const disabled = buildApp({ db, token, audioRoot: root });
  assert.equal((await disabled.inject({ url: '/v1/playlists', headers: headers() })).statusCode, 404);
  await disabled.close();
});
test('every playlist and entry mutation enforces owner scope', async () => {
  const p = await create('private', user, [local]);
  const path = `/v1/playlists/${p.id}`;
  for (const [method, url, payload] of [
    ['GET', path, undefined], ['PATCH', path, { name: 'stolen', revision: 1 }], ['DELETE', path, { revision: 1 }],
    ['POST', `${path}/entries`, { tracks: [local], revision: 1 }],
    ['PATCH', `${path}/entries/${p.entries[0].entryId}`, { position: 1, revision: 1 }],
    ['DELETE', `${path}/entries/${p.entries[0].entryId}`, { revision: 1 }],
  ] as const) {
    const response = await app.inject({ method, url, headers: headers(other), ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.deepEqual((await app.inject({ url: '/v1/playlists', headers: headers(other) })).json().items, []);
  assert.equal((await app.inject({ url: path, headers: headers() })).json().name, 'private');
});
test('mixed duplicate entries keep stable IDs through add, move, remove and rename', async () => {
  let p = await create('mixed', user, [local, remote, local]);
  assert.equal(new Set(p.entries.map((e: { entryId: string }) => e.entryId)).size, 3);
  const first = p.entries[0].entryId;
  const path = `/v1/playlists/${p.id}`;
  p = (await app.inject({ method: 'PATCH', url: `${path}/entries/${p.entries[2].entryId}`, headers: headers(), payload: { revision: p.revision, position: 1 } })).json();
  assert.equal(p.entries[1].entryId, first);
  p = (await app.inject({ method: 'DELETE', url: `${path}/entries/${first}`, headers: headers(), payload: { revision: p.revision } })).json();
  assert.deepEqual(p.entries.map((e: { source: string }) => e.source), ['local', 'remote']);
  p = (await app.inject({ method: 'POST', url: `${path}/entries`, headers: headers(), payload: { revision: p.revision, tracks: [remote] } })).json();
  assert.equal(p.entries.length, 3);
  p = (await app.inject({ method: 'PATCH', url: path, headers: headers(), payload: { revision: p.revision, name: 'new name' } })).json();
  assert.equal(p.name, 'new name'); assert.equal(p.revision, 5);
  assert.equal(p.nameKey, undefined); assert.equal(p.entries[0].playlistId, undefined);
});
test('CAS rejects simultaneous edits from separate clients and stale deletion', async () => {
  const p = await create('race');
  const secondDb = await connectDatabase(databaseUrl);
  const secondApp = buildApp({ db: secondDb, token, playlistToken: botToken, audioRoot: root });
  try {
    const requests = await Promise.all([app, secondApp].map(instance => instance.inject({ method: 'POST', url: `/v1/playlists/${p.id}/entries`, headers: headers(), payload: { revision: p.revision, tracks: [local] } })));
    assert.deepEqual(requests.map(r => r.statusCode).sort(), [200, 409]);
    const current = (await app.inject({ url: `/v1/playlists/${p.id}`, headers: headers() })).json();
    assert.equal(current.entries.length, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/playlists/${p.id}`, headers: headers(), payload: { revision: p.revision } })).statusCode, 409);
  } finally { await secondApp.close(); await secondDb.$disconnect(); }
});
test('name normalization, schema and track validation reject invalid writes atomically', async () => {
  const p = await create('ＭｉｘName');
  const duplicate = await app.inject({ method: 'POST', url: '/v1/playlists', headers: headers(), payload: { name: ' mixname ' } });
  assert.equal(duplicate.statusCode, 409);
  for (const body of [
    { name: '\n' }, { name: 'x', ownerId: other }, { name: 'x', tracks: [{ ...remote, library: 'https://secret:token@example.com/' }] },
    { name: 'x', tracks: [{ ...remote, id: 'bad' }] }, { name: 'x', tracks: Array(101).fill(local) },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/v1/playlists', headers: headers(), payload: body })).statusCode, 400);
  const invalidMove = await app.inject({ method: 'PATCH', url: `/v1/playlists/${p.id}/entries/${randomUUID()}`, headers: headers(), payload: { position: 1, revision: 1 } });
  assert.equal(invalidMove.statusCode, 404);
  assert.equal((await app.inject({ url: `/v1/playlists/${p.id}`, headers: headers() })).json().revision, 1);
});
test('100-song batch capacity and 20-playlist per-user capacity do not partially write', async () => {
  const owner = '323456789012345678';
  const full = await create('full', owner, Array(99).fill(local));
  assert.equal((await app.inject({ method: 'POST', url: `/v1/playlists/${full.id}/entries`, headers: headers(owner), payload: { revision: 1, tracks: [local, remote] } })).statusCode, 409);
  assert.equal((await app.inject({ url: `/v1/playlists/${full.id}`, headers: headers(owner) })).json().entries.length, 99);
  for (let i = 1; i < 20; i++) await create(`list-${i}`, owner);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/playlists', headers: headers(owner), payload: { name: 'too many' } })).statusCode, 409);
  await create('other quota', '423456789012345678');
});
test('removed playlist import route cannot create or overwrite database records', async () => {
  const count = await db.playlist.count();
  const response = await app.inject({ method: 'PUT', url: `/v1/playlists/${randomUUID()}/import`,
    headers: headers(), payload: { name: 'unsupported', revision: 1, entries: [] } });
  assert.equal(response.statusCode, 404);
  assert.equal(await db.playlist.count(), count);
});
test('database persistence survives reopening and delete cascades only playlist entries', async () => {
  const p = await create('persist', user, [local, remote]);
  const connection = await connectDatabase(databaseUrl);
  assert.equal((await connection.playlist.findUniqueOrThrow({ where: { id: p.id }, include: { entries: true } })).entries.length, 2);
  await connection.$disconnect();
  const songCount = await db.song.count();
  const result = await app.inject({ method: 'DELETE', url: `/v1/playlists/${p.id}`, headers: headers(), payload: { revision: p.revision } });
  assert.equal(result.statusCode, 204); assert.equal(await db.playlistEntry.count({ where: { playlistId: p.id } }), 0);
  assert.equal(await db.song.count(), songCount);
});
test('config rejects reused playlist credentials', () => {
  const previous = process.env.PLAYLIST_BOT_TOKEN;
  try {
    process.env.PLAYLIST_BOT_TOKEN = process.env.API_TOKEN;
    assert.throws(() => playlistBotToken());
  } finally { if (previous === undefined) delete process.env.PLAYLIST_BOT_TOKEN; else process.env.PLAYLIST_BOT_TOKEN = previous; }
});

test('removing import metadata preserves existing playlists, entries and revisions', async () => {
  const legacySchema = join(root, 'previous-schema');
  await mkdir(join(legacySchema, 'migrations'), { recursive: true });
  await cp('prisma/schema.prisma', join(legacySchema, 'schema.prisma'));
  for (const migration of await readdir('prisma/migrations')) {
    if (migration === '20261008000000_remove_playlist_import') continue;
    await cp(join('prisma/migrations', migration), join(legacySchema, 'migrations', migration), { recursive: true });
  }
  const upgradeUrl = `file:${join(root, 'upgrade.sqlite')}`;
  const deploy = (schema: string) => execFileSync(process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', schema],
    { env: { ...process.env, DATABASE_URL: upgradeUrl, RUST_LOG: 'info' }, stdio: 'pipe' });
  deploy(join(legacySchema, 'schema.prisma'));
  const connection = await connectDatabase(upgradeUrl);
  const id = randomUUID(), entryId = randomUUID();
  try {
    await connection.$executeRaw`INSERT INTO playlists (id, owner_id, name, name_key, revision, import_hash)
      VALUES (${id}, ${user}, 'existing', 'existing', 7, 'obsolete-metadata')`;
    await connection.$executeRaw`INSERT INTO playlist_entries (entry_id, playlist_id, position, source, track_id, title)
      VALUES (${entryId}, ${id}, 0, 'local', 'song', 'existing song')`;
    await connection.$disconnect();
    deploy('prisma/schema.prisma');
    const p = await connection.playlist.findUniqueOrThrow({ where: { id }, include: { entries: true } });
    assert.equal(p.ownerId, user); assert.equal(p.revision, 7);
    assert.equal(p.entries[0]?.entryId, entryId);
    const columns = await connection.$queryRaw<{ name: string }[]>`PRAGMA table_info('playlists')`;
    assert.ok(!columns.some(column => column.name === 'import_hash'));
  } finally { await connection.$disconnect(); }
});
