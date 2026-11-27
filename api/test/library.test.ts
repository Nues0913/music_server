import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { connectDatabase } from '../src/infrastructure/database.js';
import { buildApp } from '../src/app.js';
import { importFile, type ImportOptions } from '../src/modules/ingestion/importer.js';

let root: string;
let db: PrismaClient;
let app: ReturnType<typeof buildApp>;
let options: ImportOptions;
const token = 'test-only-token-012345678901234567890123456789';
const headers = { authorization: `Bearer ${token}` };
const adminToken = 'admin-only-token-012345678901234567890123456789';

function wav(seconds = 1, amplitude = 0, withPeaks = false) {
  const bytes = 16000 * seconds;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) {
    const sample = withPeaks && i % 8000 === 2000 ? 31500 : amplitude * Math.sin(2 * Math.PI * 440 * i / 8000);
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  return buffer;
}

function measure(path: string) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0',
    '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = result.stderr.split('Summary:').at(-1)!;
  return { lufs: Number(summary.match(/I:\s+([\d.-]+)\s+LUFS/)?.[1]),
    peak: Number(summary.match(/Peak:\s+([\d.-]+)\s+dBFS/)?.[1]) };
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
  options = { db, audioRoot, inbox, maxBytes: 1000000, minFreeBytes: 1, quotaBytes: 2000000 };
  app = buildApp({ db, token, audioRoot, upload: { ...options, adminToken } });
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
  const source = join(options.inbox, 'valid.wav'); const unique = wav(); unique.writeInt16LE(13, 44); await writeFile(source, unique);
  await assert.rejects(importFile({ ...options, quotaBytes: 1 }, source), /quota/);
  await assert.rejects(importFile({ ...options, minFreeBytes: Number.MAX_SAFE_INTEGER }, source), /disk/);
  await assert.rejects(importFile({ ...options, maxBytes: 1 }, source), /size/);
  await assert.rejects(importFile(options, join(root, 'outside.wav')), /first-level/);
  assert.equal(await db.song.count(), count);
  assert.equal((await readdir(options.audioRoot)).some(name => name.endsWith('.part') || name === '.import-lock'), false);
});

test('duplicates at full quota repair missing/corrupted audio without changing rows or deleting inbox originals', async () => {
  const source = join(options.inbox, 'repair.wav'), audio = wav(); audio.writeInt16LE(39, 44);
  await writeFile(source, audio);
  const initial = await importFile(options, source);
  const record = await db.song.findUniqueOrThrow({ where: { id: initial.id } });
  const path = join(options.audioRoot, record.fileKey);
  const full = { ...options, quotaBytes: 1 };
  assert.deepEqual(await importFile(full, source), { status: 'duplicate', id: initial.id });
  await rm(path);
  assert.deepEqual(await importFile(full, source), { status: 'duplicate', id: initial.id });
  assert.deepEqual(await readFile(path), audio);
  const corrupt = Buffer.from(audio); corrupt.writeInt16LE(40, 44); await writeFile(path, corrupt);
  await importFile(full, source); assert.deepEqual(await readFile(path), audio);
  assert.deepEqual(await db.song.findUniqueOrThrow({ where: { id: initial.id } }), record);
  assert.deepEqual(await readFile(source), audio);
  await db.song.update({ where: { id: initial.id }, data: { status: 'disabled' } });
  await rm(path); await importFile(full, source);
  assert.equal((await db.song.findUniqueOrThrow({ where: { id: initial.id } })).status, 'disabled');
  await rm(path); await symlink(source, path);
  await assert.rejects(importFile(full, source), /regular stored audio/);
  await rm(path); await writeFile(path, audio);
  await assert.rejects(importFile({ ...full, minFreeBytes: Number.MAX_SAFE_INTEGER }, source), /disk/);
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
  assert.equal((await app.inject('/admin/config')).json().maxBytes, options.maxBytes);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/songs', ...multipartPayload(wav()), headers })).statusCode, 401);
});

test('multipart upload normalizes in linear mode, saves the output hash and preserves duplicate ID and metadata', async () => {
  const audio = wav(2, 1200);
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
  assert.equal(saved.mimeType, 'audio/wav');
  const path = join(options.audioRoot, saved.fileKey);
  const stored = await readFile(path);
  assert.equal(stored.toString('ascii', 0, 4), 'RIFF');
  assert.equal(saved.byteSize, stored.length);
  assert.equal(saved.sha256, createHash('sha256').update(stored).digest('hex'));
  assert.equal(saved.uploadSourceSha256, createHash('sha256').update(audio).digest('hex'));
  assert.notEqual(saved.sha256, saved.uploadSourceSha256);
  const output = measure(path);
  assert.ok(Math.abs(output.lufs - (-17)) <= 0.3, JSON.stringify(output));
  assert.ok(output.peak <= -2, JSON.stringify(output));
  assert.ok(Math.abs(saved.durationSeconds! - 2) <= 0.01);
  const publicSong = (await app.inject({ url: `/v1/songs/${id}`, headers })).json();
  assert.equal(publicSong.sha256, saved.sha256);
  assert.equal(publicSong.byteSize, saved.byteSize);
  assert.equal(publicSong.uploadSourceSha256, undefined);
  const duplicate = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
  assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().status, 'duplicate');
  assert.equal(duplicate.json().id, id);
  await rm(path);
  const repair = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
  assert.equal(repair.statusCode, 200, repair.body);
  assert.deepEqual(await readFile(path), stored);
  assert.deepEqual(await db.song.findUniqueOrThrow({ where: { id } }), saved);
  assert.deepEqual(await readdir(join(options.audioRoot, '.uploads')), []);
});

test('peak-limited MP3 upload uses dynamic normalization and respects the peak ceiling after encoding', async () => {
  const input = join(root, 'peaks.wav'); await writeFile(input, wav(4, 950, true));
  const source = join(root, 'peaks.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-ar', '48000', '-c:a', 'libmp3lame', '-q:a', '0', source]);
  const original = measure(source);
  assert.ok(original.peak + (-17 - original.lufs) > -2, JSON.stringify(original));
  const response = await app.inject({ method: 'POST', url: '/v1/songs', ...multipartPayload(await readFile(source), 'peaks.mp3') });
  assert.equal(response.statusCode, 201, response.body);
  const saved = await db.song.findUniqueOrThrow({ where: { id: response.json().id } });
  const output = measure(join(options.audioRoot, saved.fileKey));
  assert.ok(Math.abs(output.lufs + 17) <= 1, JSON.stringify(output));
  assert.ok(output.peak <= -2, JSON.stringify(output));
  assert.ok(Math.abs(saved.durationSeconds! - 4) <= 0.01);
});

test('uploads retain every accepted extension and MIME type, including mixed case, with real normalized audio', async t => {
  const formats = [
    { suffix: 'MP3', encoder: 'libmp3lame', codec: 'mp3', mime: 'audio/mpeg' },
    { suffix: 'FLAC', encoder: 'flac', codec: 'flac', mime: 'audio/flac' },
    { suffix: 'Wav', encoder: 'pcm_s16le', codec: 'pcm_s24le', mime: 'audio/wav' },
    { suffix: 'ogg', encoder: 'libvorbis', codec: 'vorbis', mime: 'audio/ogg' },
    { suffix: 'opus', encoder: 'libopus', codec: 'opus', mime: 'audio/ogg' },
    { suffix: 'm4a', encoder: 'aac', codec: 'aac', mime: 'audio/mp4' },
    { suffix: 'webm', encoder: 'libopus', codec: 'opus', mime: 'audio/webm' },
  ];
  for (const [index, { suffix, encoder, codec, mime }] of formats.entries()) {
    await t.test(suffix, async () => {
      const source = join(root, `source.${suffix.toLowerCase()}`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 10}:duration=2`,
        '-c:a', encoder, source]);
      const request = multipartPayload(await readFile(source), `source.${suffix}`);
      const response = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
      assert.equal(response.statusCode, 201, response.body);
      const saved = await db.song.findUniqueOrThrow({ where: { id: response.json().id } });
      assert.ok(saved.fileKey.endsWith(`.${suffix}`), saved.fileKey);
      assert.equal(saved.mimeType, mime);
      const destination = join(options.audioRoot, saved.fileKey);
      const streamCodec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name',
        '-of', 'default=nw=1:nk=1', destination], { encoding: 'utf8' }).trim();
      assert.equal(streamCodec, codec);
      const output = measure(destination);
      assert.ok(Math.abs(output.lufs + 17) <= 0.6 && output.peak <= -2, JSON.stringify(output));
      const stream = await app.inject({ url: `/v1/songs/${saved.id}/audio`, headers });
      assert.equal(stream.statusCode, 200);
      assert.equal(stream.headers['x-accel-redirect'], `/protected-audio/${saved.fileKey}`);
      await rm(destination);
      const repair = await app.inject({ method: 'POST', url: '/v1/songs', ...request });
      assert.equal(repair.statusCode, 200, repair.body);
      assert.equal(repair.json().id, saved.id);
      assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'), saved.sha256);
    });
  }
});

test('WAV output that grows past the size cap leaves neither a song nor partial audio', async t => {
  const audio = wav(2, 3330);
  const maxBytes = 100000;
  assert.ok(audio.length < maxBytes);
  const limited = buildApp({ db, token, audioRoot: options.audioRoot, upload: { ...options, adminToken, maxBytes } });
  t.after(() => limited.close());
  const count = await db.song.count();
  const response = await limited.inject({ method: 'POST', url: '/v1/songs', ...multipartPayload(audio, 'over-limit.wav') });
  assert.equal(response.statusCode, 413, response.body);
  assert.match(response.json().error, /響度正規化/);
  assert.equal(await db.song.count(), count);
  assert.deepEqual(await readdir(join(options.audioRoot, '.uploads')), []);
  assert.equal((await readdir(options.audioRoot)).some(name => name.endsWith('.part') || name === '.import-lock'), false);
});

test('oversized, invalid and extra-field uploads clean staging without publishing', async () => {
  const count = await db.song.count();
  const cases = [
    { request: multipartPayload(Buffer.alloc(options.maxBytes + 1)), status: 413 },
    { request: multipartPayload(Buffer.from('invalid audio')), status: 400 },
    { request: multipartPayload(wav(3)), status: 400 },
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

test('disconnect after request body kills FFmpeg, cleans temporary files and releases the import lock', { timeout: 10000 }, async () => {
  const bin = join(root, 'test-bin');
  const pidFile = join(root, 'ffmpeg.pid');
  await mkdir(bin);
  await writeFile(join(bin, 'ffmpeg'), '#!/bin/sh\nprintf "%s" "$$" > "$UPLOAD_TEST_PID_FILE"\nexec sleep 60\n', { mode: 0o700 });
  const savedPath = process.env.PATH ?? '';
  const count = await db.song.count();
  const { headers, payload } = multipartPayload(wav(2, 2300));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.UPLOAD_TEST_PID_FILE = pidFile;
  const request = httpRequest(`http://127.0.0.1:${address.port}/v1/songs`, {
    method: 'POST', headers: { ...headers, 'content-length': payload.length },
  });
  request.on('error', () => {});
  try {
    request.end(payload);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      if (!pid) await delay(20);
    }
    assert.ok(pid, 'FFmpeg started after receiving the complete upload');
    request.destroy();
    const staging = join(options.audioRoot, '.uploads');
    for (let i = 0; i < 100 && (await readdir(staging)).length; i++) await delay(20);
    assert.deepEqual(await readdir(staging), []);
    assert.ok(!(await readdir(options.audioRoot)).includes('.import-lock'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(await db.song.count(), count);
  } finally {
    request.destroy();
    process.env.PATH = savedPath;
    delete process.env.UPLOAD_TEST_PID_FILE;
  }
  const retry = await app.inject({ method: 'POST', url: '/v1/songs', headers, payload });
  assert.equal(retry.statusCode, 201, retry.body);
});
