import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080';
const headers = { Authorization: `Bearer ${process.env.API_TOKEN}` };
const get = (path, options = {}) => fetch(base + path, { signal: AbortSignal.timeout(15000), ...options });
assert.equal((await get('/health')).status, 200);
assert.equal((await get('/v1/songs')).status, 401);
const listing = await get('/v1/songs?query=' + encodeURIComponent('smoke-test-中文'), { headers });
assert.equal(listing.status, 200);
const { items } = await listing.json();
assert.ok(items.length > 0, 'Import the synthetic fixture first');
const song = items[0];
const path = `/v1/songs/${song.id}/audio`;
const response = await get(path, { headers });
assert.equal(response.status, 200);
const full = Buffer.from(await response.arrayBuffer());
assert.equal(full.length, song.byteSize);
assert.equal(createHash('sha256').update(full).digest('hex'), song.sha256);
const head = await get(path, { method: 'HEAD', headers });
assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), full.length);
const range = await get(path, { headers: { ...headers, Range: 'bytes=0-43' } });
assert.equal(range.status, 206);
assert.equal(range.headers.get('content-range'), `bytes 0-43/${full.length}`);
assert.deepEqual(Buffer.from(await range.arrayBuffer()), full.subarray(0, 44));
assert.equal((await get(path)).status, 401);
assert.equal((await get('/protected-audio/anything.wav', { headers })).status, 404);
const concurrent = await Promise.all([get(path, { headers }), get(path, { headers })]);
for (const result of concurrent) {
  assert.equal(result.status, 200);
  assert.equal((await result.arrayBuffer()).byteLength, full.length);
}
console.log('PASS: health, auth, Chinese search, SHA-256, HEAD, Range, private path, 2 concurrent streams');

