import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectDatabase } from '../dist/infrastructure/database.js';
import { buildApp } from '../dist/app.js';
import { importFile } from '../dist/modules/ingestion/importer.js';
import { createUploadController } from '../public/uploads/controller.js';

// Isolated real SQLite/Fastify/Nginx contract test. Optional Bot path tests the cross-repo resolver.
const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const nginxRoot = resolve(apiRoot, '../nginx');
const root = await mkdtemp('/tmp/music-nginx-contract-');
const container = `music-contract-${process.pid}`, network = `${container}-net`;
const audioRoot = join(root, 'audio'), inbox = join(root, 'inbox');
const token = 'nginx-fixture-api-token-012345678901234567890';
const adminToken = 'nginx-fixture-admin-token-012345678901234567890';
let db, app, createdNetwork = false, createdContainer = false, logger;
const upstreams = new Set();
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  await mkdir(audioRoot); await mkdir(inbox);
  const databaseUrl = `file:${join(root, 'test.db')}?connection_limit=1`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: apiRoot, env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'info' }, stdio: 'pipe'
  });
  db = await connectDatabase(databaseUrl);
  const options = { db, audioRoot, inbox, maxBytes: 100000, minFreeBytes: 1, quotaBytes: 10000000 };
  app = buildApp({ db, token, audioRoot, upload: { ...options, adminToken } });
  const address = await app.listen({ host: '0.0.0.0', port: 0 });
  const apiPort = new URL(address).port;
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
  const source = join(inbox, 'fixture.wav'); await writeFile(source, buffer);
  const saved = await importFile(options, source);
  docker(['network', 'create', network]); createdNetwork = true;
  docker(['run', '-d', '--name', container, '--network', network, '--add-host', 'host.docker.internal:host-gateway',
    '-p', '127.0.0.1::80', '-e', `API_UPSTREAM=host.docker.internal:${apiPort}`, '-e', 'AUDIO_ROOT=/fixture/audio',
    '-v', `${root}:/fixture:ro`, '-v', `${nginxRoot}:/opt/music-nginx:ro`,
    '-v', `${nginxRoot}/nginx.conf:/etc/nginx/nginx.conf:ro`,
    '-v', `${nginxRoot}/locations.conf:/etc/nginx/snippets/music-locations.conf:ro`,
    '-v', `${nginxRoot}/docker-start.sh:/docker-entrypoint.d/25-music-config.sh:ro`,
    'nginx:1.30-alpine']); createdContainer = true;
  const port = JSON.parse(docker(['inspect', container]))[0].NetworkSettings.Ports['80/tcp'][0].HostPort;
  const base = `http://127.0.0.1:${port}/`;
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = await fetch(`${base}health`); healthy = response.status === 200; await response.body?.cancel(); if (healthy) break; }
    catch { /* Wait for the entrypoint and Nginx to listen. */ }
    await delay(100);
  }
  assert.ok(healthy, 'documented host API + Docker Nginx deployment must resolve extra_hosts');
  assert.match(docker(['exec', container, 'cat', '/etc/nginx/conf.d/default.conf']), /set \$api_backend "[0-9.]+:/);
  docker(['exec', container, 'nginx', '-t']);
  const headers = { authorization: `Bearer ${token}`, 'x-discord-user-id': '123456789012345678', 'content-type': 'application/json' };
  const tracks = Array.from({ length: 100 }, (_, i) => ({ source: 'local', id: `song-${i}`, title: '測試歌曲'.repeat(10) }));
  const body = JSON.stringify({ name: '100 song proxy test', tracks });
  assert.ok(Buffer.byteLength(body) > 1024);
  let response = await fetch(`${base}v1/playlists`, { method: 'POST', headers, body });
  assert.equal(response.status, 201, await response.text());
  response = await fetch(`${base}v1/playlists`, { method: 'POST', headers, body: ' '.repeat(512 * 1024 + 1) });
  assert.equal(response.status, 413); await response.body?.cancel();
  response = await fetch(`${base}protected-audio/fixture.wav`); assert.equal(response.status, 404); await response.body?.cancel();
  console.log('PASS: host alias startup, Nginx syntax, 100-song playlist JSON, size and private audio boundaries');

  if (process.argv[2]) {
    process.env.REMOTE_MUSIC_API_URL = base; process.env.REMOTE_MUSIC_API_TOKEN = token;
    const botRoot = resolve(process.argv[2]);
    ({ default: logger } = await import(pathToFileURL(join(botRoot, 'dist/shared/logging/logger.js'))));
    const { resolvePlaylist } = await import(pathToFileURL(join(botRoot, 'dist/features/playlists/tracks.js')));
    const reference = id => ({ source: 'remote', id, title: 'fixture', library: base });
    const repeated = await resolvePlaylist(Array.from({ length: 100 }, () => reference(saved.id)));
    assert.equal(repeated.tracks.length, 100); assert.deepEqual(repeated.unavailable, []);
    const unique = [];
    for (let i = 0; i < 100; i++) {
      const content = Buffer.from(buffer); content.writeInt16LE(i + 1, 44);
      await writeFile(source, content);
      const song = await importFile(options, source);
      unique.push(reference(song.id));
    }
    const distinct = await resolvePlaylist(unique);
    assert.equal(distinct.tracks.length, 100); assert.deepEqual(distinct.unavailable, []);
    assert.deepEqual(distinct.tracks.map(t => t.id), unique.map(t => t.id));
    console.log('PASS: real Bot resolver preserves 100 duplicate and 100 distinct remote entries through rate-limited Nginx');
  }
  await delay(1200);
  const entries = [], statuses = [];
  const view = { values: () => ({ files: Array.from({ length: 30 }, (_, i) => ({ name: `batch-${i}.wav`, size: buffer.length })), token: adminToken }),
    selected() {}, renderEntries(items) { entries.splice(0, entries.length, ...items); }, busy() {}, progress() {}, clearResult() {},
    clearFileInput() {}, hideProgress() {}, configure() {}, entry() {}, message() {} };
  const controller = createUploadController(view, { config: async () => ({ enabled: true, maxBytes: 100000 }), upload(values) {
    const data = new FormData(); data.append('title', values.title); data.append('artist', values.artist);
    data.append('file', new Blob([buffer], { type: 'audio/wav' }), values.file.name);
    const controller = new AbortController();
    const done = fetch(`${base}v1/songs`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: data, signal: controller.signal }).then(async response => {
      statuses.push(response.status);
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, retryAfter: response.headers.get('retry-after') }); }
      return response.json();
    });
    return { done, abort: () => controller.abort() };
  } });
  await controller.initialize(); controller.chooseFile(); await controller.submit(); controller.dispose();
  assert.ok(statuses.includes(429), 'batch should exercise actual rate-limit retry');
  assert.equal(entries.length, 30); assert.ok(entries.every(e => e.state === 'duplicate'));
  console.log('PASS: 30-file admin batch recovers from actual Nginx 429 without failing valid files');

  // The host alias fix must not pin a Compose service to its startup IP.
  async function startUpstream(name, content) {
    const config = join(root, `${name}.conf`);
    await writeFile(config, `server { listen 80; location / { return 200 '${content}'; } }\n`);
    docker(['run', '-d', '--name', name, '--network', network, '--network-alias', 'api',
      '-v', `${config}:/etc/nginx/conf.d/default.conf:ro`, 'nginx:1.30-alpine']);
    upstreams.add(name);
  }
  const first = `${container}-first`, second = `${container}-second`;
  await startUpstream(first, 'first upstream');
  docker(['exec', '-e', 'API_UPSTREAM=api:80', container, 'sh', '/docker-entrypoint.d/25-music-config.sh']);
  assert.match(docker(['exec', container, 'cat', '/etc/nginx/conf.d/default.conf']), /set \$api_backend "api:80"/);
  docker(['exec', container, 'nginx', '-s', 'reload']);
  async function waitForUpstream(content) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { const response = await fetch(`${base}health`); const text = await response.text(); if (response.status === 200 && text === content) return; }
      catch { /* Old DNS entries may survive until the configured cache expires. */ }
      await delay(1000);
    }
    assert.fail(`Nginx did not resolve ${content}`);
  }
  await waitForUpstream('first upstream');
  const firstIp = JSON.parse(docker(['inspect', first]))[0].NetworkSettings.Networks[network].IPAddress;
  await startUpstream(second, 'second upstream');
  const secondIp = JSON.parse(docker(['inspect', second]))[0].NetworkSettings.Networks[network].IPAddress;
  assert.notEqual(firstIp, secondIp);
  docker(['rm', '-f', first]); upstreams.delete(first);
  await waitForUpstream('second upstream');
  console.log('PASS: Compose service remains DNS-based and recovers after replacement at a different IP');
} finally {
  logger?.close();
  for (const name of upstreams) docker(['rm', '-f', name]);
  if (createdContainer) docker(['rm', '-f', container]);
  if (createdNetwork) docker(['network', 'rm', network]);
  await app?.close(); await db?.$disconnect(); await rm(root, { recursive: true, force: true });
}
