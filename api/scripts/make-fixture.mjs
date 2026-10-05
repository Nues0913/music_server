import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const folder = resolve(process.argv[2] ?? '../data/inbox');
await mkdir(folder, { recursive: true });
const wav = Buffer.alloc(44 + 32000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(32000, 40);
for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(Math.round(2000 * Math.sin(offset / 16)), offset);
await writeFile(join(folder, 'smoke-test-中文.wav'), wav);
console.log('Created synthetic WAV fixture (2 seconds)');

