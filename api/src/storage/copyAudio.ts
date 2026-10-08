import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidAudioError } from './errors.js';

export async function copyAudio(source: string, temporary: string, expectedSize: number, maxBytes: number) {
  let bytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > expectedSize || bytes > maxBytes) return callback(new InvalidAudioError('Input grew during import'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(createReadStream(source), meter, createWriteStream(temporary, { flags: 'wx' }));
  if (bytes !== expectedSize) throw new InvalidAudioError('Input changed during import');
  return { byteSize: bytes, sha256: hash.digest('hex') };
}

export async function audioMatches(path: string, size: number, sha256: string): Promise<boolean> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > size) return false;
    hash.update(chunk);
  }
  return bytes === size && hash.digest('hex') === sha256;
}
