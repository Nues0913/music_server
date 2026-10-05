import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { connectDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { importFile, type ImportOptions } from '../src/importer.js';

let root: string;
let db: PrismaClient;
let app: ReturnType<typeof buildApp>;
let options: ImportOptions;
const token = 'test-only-token-012345678901234567890123456789';
const headers = { authorization: `Bearer ${token}` };
const adminToken = 'admin-only-token-012345678901234567890123456789';

function wav() {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
  return buffer;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'music-api-test-'));
  const audioRoot = join(root, 'audio'); const inbox = join(root, 'inbox');
  await mkdir(audioRoot); await mkdir(inbox);
  const url = `file:${join(root, 'test.db').replaceAll('\\', '/')}?connection_limit=1`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, stdio: 'pipe',
  });
  db = await connectDatabase(url);
  options = { db, audioRoot, inbox, maxBytes: 100000, minFreeBytes: 1, quotaBytes: 1000000 };
  app = buildApp({ db, token, audioRoot, upload: { adminToken, maxBytes: 100000, minFreeBytes: 1, quotaBytes: 1000000 } });
});
after(async () => {
  if (app) await app.close();
  if (db) await db.$disconnect();
  if (root) await rm(root, { recursive: true, force: true });
});

test('authorization and bounded request parameters', async () => {
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/v1/songs')).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/songs', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  for (const url of ['/v1/songs?limit=26', '/v1/songs?limit=0', '/v1/songs?cursor=bad', '/v1/songs?unknown=1']) {
    assert.equal((await app.inject({ url, headers })).statusCode, 400);
  }
});

test('import, deduplication, Chinese search, HEAD and disabled songs', async () => {
  const source = join(options.inbox, '中文 測試.wav');
  await writeFile(source, wav());
  const result = await importFile(options, source);
  assert.equal(result.status, 'imported');
  assert.equal((await importFile(options, source)).status, 'duplicate');
  assert.equal(await db.song.count(), 1);
  const response = await app.inject({ url: '/v1/songs?query=' + encodeURIComponent('中文'), headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].title, '中文 測試');
  assert.equal(response.json().items[0].fileKey, undefined);
  const audio = await app.inject({ url: `/v1/songs/${result.id}/audio`, headers });
  assert.equal(audio.statusCode, 200);
  assert.match(audio.headers['x-accel-redirect'] as string, /^\/protected-audio\//);
  const head = await app.inject({ method: 'HEAD', url: `/v1/songs/${result.id}/audio`, headers });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
  await db.song.update({ where: { id: result.id }, data: { status: 'disabled' } });
  assert.equal((await app.inject({ url: '/v1/songs', headers })).json().items.length, 0);
  assert.equal((await app.inject({ url: `/v1/songs/${result.id}/audio`, headers })).statusCode, 404);
});

test('bad files and disk/quota constraints leave no visible rows or partial files', async () => {
  const count = await db.song.count();
  const bad = join(options.inbox, 'broken.mp3');
  await writeFile(bad, 'not music');
  await assert.rejects(importFile(options, bad));
  const source = join(options.inbox, 'valid.wav'); await writeFile(source, wav());
  await assert.rejects(importFile({ ...options, quotaBytes: 1 }, source), /quota/);
  await assert.rejects(importFile({ ...options, minFreeBytes: Number.MAX_SAFE_INTEGER }, source), /disk/);
  await assert.rejects(importFile({ ...options, maxBytes: 1 }, source), /size/);
  await assert.rejects(importFile(options, join(root, 'outside.wav')), /first-level/);
  assert.equal(await db.song.count(), count);
  assert.equal((await readdir(options.audioRoot)).some(name => name.endsWith('.part') || name === '.import-lock'), false);
});

test('keyset pages do not overlap and invalid stored paths are not served', async () => {
  for (let i = 1; i <= 3; i++) {
    await db.song.create({ data: {
      id: `00000000-0000-4000-8000-00000000000${i}`, fileKey: `../outside-${i}.wav`,
      title: `分頁 ${i}`, mimeType: 'audio/wav', byteSize: 1, sha256: `test-${i}`,
    } });
  }
  const first = (await app.inject({ url: '/v1/songs?limit=2', headers })).json();
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = (await app.inject({ url: `/v1/songs?limit=2&cursor=${first.nextCursor}`, headers })).json();
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 3);
  assert.equal((await app.inject({ url: `/v1/songs/${first.items[0].id}/audio`, headers })).statusCode, 404);
});

function multipartPayload(file: Buffer, filename = '上傳.wav', extra = '', fields = '') {
  const boundary = 'music-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(fields + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`),
    file, Buffer.from(`\r\n${extra}--${boundary}--\r\n`),
  ]);
  return { payload, headers: { authorization: `Bearer ${adminToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('admin UI does not expose credentials; playback token cannot upload', async () => {
  const page = await app.inject('/admin');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /新增歌曲/);
  assert.ok(!page.body.includes(adminToken));
  assert.ok(!page.body.includes(token));
  assert.match(page.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  assert.equal((await app.inject('/admin/config')).json().maxBytes, 100000);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/songs', ...multipartPayload(wav()), headers })).statusCode, 401);
});

test('multipart upload supports metadata after file, duplicate detection and path-safe names', async () => {
  const audio = wav(); audio.writeInt16LE(51, 44);
  const metadata = '--music-test-boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\n網頁歌曲\r\n' +
    '--music-test-boundary\r\nContent-Disposition: form-data; name="artist"\r\n\r\n測試歌手\r\n';
  const request = multipartPayload(audio, '../../上傳.wav', metadata);
  const response = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().song.title, '網頁歌曲');
  assert.equal(response.json().song.artist, '測試歌手');
  const id = response.json().id;
  const saved = await db.song.findUniqueOrThrow({ where: { id } });
  assert.match(saved.fileKey, /^[a-f0-9-]+\.wav$/);
  const duplicate = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
  assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().status, 'duplicate');
  assert.equal(duplicate.json().id, id);
  assert.deepEqual(await readdir(join(options.audioRoot, '.uploads')), []);
});

test('oversized, invalid and extra-field uploads clean staging without publishing', async () => {
  const count = await db.song.count();
  const cases = [
    { request: multipartPayload(Buffer.alloc(100001)), status: 413 },
    { request: multipartPayload(Buffer.from('invalid audio')), status: 400 },
    { request: multipartPayload(wav(), 'script.exe'), status: 415 },
    { request: multipartPayload(wav(), 'valid.wav', '--music-test-boundary\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nvalue\r\n'), status: 400 },
  ];
  for (const { request, status } of cases) {
    const response = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(await db.song.count(), count);
    assert.deepEqual(await readdir(join(options.audioRoot, '.uploads')), []);
  }
});

test('aborted upload releases the slot and removes staging without inserting a song', { timeout: 10000 }, async () => {
  const count = await db.song.count();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const upload = httpRequest(`${address}/v1/songs`, { method: 'POST', headers: {
    authorization: `Bearer ${adminToken}`,
    'content-type': 'multipart/form-data; boundary=abort-boundary',
  } });
  upload.on('error', () => {});
  upload.write('--abort-boundary\r\nContent-Disposition: form-data; name="file"; filename="interrupted.wav"\r\nContent-Type: audio/wav\r\n\r\n');
  upload.write(wav().subarray(0, 100));
  for (let i = 0; i < 100; i++) {
    if ((await readdir(join(options.audioRoot, '.uploads'))).length) break;
    await delay(20);
  }
  const busy = await app.inject({ method: 'POST', url: '/v1/songs', ...multipartPayload(wav()) });
  assert.equal(busy.statusCode, 409);
  upload.destroy();
  for (let i = 0; i < 100; i++) {
    if (!(await readdir(join(options.audioRoot, '.uploads'))).length) break;
    await delay(20);
  }
  assert.deepEqual(await readdir(join(options.audioRoot, '.uploads')), []);
  assert.equal(await db.song.count(), count);
  const next = await app.inject({ method: 'POST', url: '/v1/songs', ...multipartPayload(wav()) });
  assert.equal(next.statusCode, 200, next.body);
});
