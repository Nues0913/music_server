import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function copyAudio(source: string, temporary: string, expectedSize: number, maxBytes: number) {
  let bytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > expectedSize || bytes > maxBytes) return callback(new Error('Input grew during import'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(createReadStream(source), meter, createWriteStream(temporary, { flags: 'wx' }));
  if (bytes !== expectedSize) throw new Error('Input changed during import');
  return { byteSize: bytes, sha256: hash.digest('hex') };
}
