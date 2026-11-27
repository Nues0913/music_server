import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1';
const dataSize = 16 * 1024 * 1024;
const wav = Buffer.alloc(44);
wav.write('RIFF'); wav.writeUInt32LE(dataSize + 36, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
const boundary = 'upload-smoke-stream';
const preamble = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n大檔串流驗證\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stream-test.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
const hash = createHash('sha256');
const request = new URL(base).protocol === 'https:' ? httpsRequest : httpRequest;
const req = request(`${base}/v1/songs`, { method: 'POST', headers: {
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
  'Content-Type': `multipart/form-data; boundary=${boundary}`,
  'Content-Length': preamble.length + wav.length + dataSize + closing.length,
} });
const responsePromise = new Promise((resolve, reject) => {
  req.on('error', reject);
  req.on('response', response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('error', reject);
    response.on('end', () => resolve({ status: response.statusCode, body }));
  });
});
const tone = Buffer.alloc(64 * 1024);
for (let frame = 0; frame < tone.length / 4; frame++) {
  const sample = Math.round(2000 * Math.sin(2 * Math.PI * frame / 128));
  tone.writeInt16LE(sample, frame * 4);
  tone.writeInt16LE(sample, frame * 4 + 2);
}
await pipeline(Readable.from((async function* () {
  yield preamble;
  hash.update(wav); yield wav;
  for (let bytes = 0; bytes < dataSize; bytes += tone.length) { hash.update(tone); yield tone; }
  yield closing;
})()), req);
const response = await responsePromise;
assert.ok([200, 201].includes(response.status), response.body);
const result = JSON.parse(response.body);
const headers = { Authorization: `Bearer ${process.env.API_TOKEN}` };
const metadata = await fetch(`${base}/v1/songs/${result.id}`, { headers });
assert.equal(metadata.status, 200);
const song = await metadata.json();
assert.equal(song.mimeType, 'audio/flac');
assert.notEqual(song.sha256, hash.digest('hex'));
const audioUrl = `${base}/v1/songs/${result.id}/audio`;
const header = await fetch(audioUrl, { headers: { ...headers, Range: 'bytes=0-3' } });
assert.equal(header.status, 206);
assert.equal(await header.text(), 'fLaC');
const audio = await fetch(audioUrl, { headers });
assert.equal(audio.status, 200);
const storedHash = createHash('sha256');
let storedBytes = 0;
for await (const chunk of audio.body) { storedBytes += chunk.length; storedHash.update(chunk); }
assert.equal(song.byteSize, storedBytes);
assert.equal(song.sha256, storedHash.digest('hex'));
console.log(`PASS: 16 MiB streamed upload via Nginx and normalized FLAC size, SHA-256 and Range (${result.status})`);
