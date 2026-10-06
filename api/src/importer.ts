import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import type { PrismaClient } from '@prisma/client';

const mimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.webm': 'audio/webm',
};
export type ImportOptions = {
  db: PrismaClient; audioRoot: string; inbox: string;
  maxBytes: number; minFreeBytes: number; quotaBytes: number;
};

export async function importFile(options: ImportOptions, source: string, labels: { originalName?: string; title?: string; artist?: string } = {}) {
  const { db, audioRoot, inbox, maxBytes, minFreeBytes, quotaBytes } = options;
  const inputRoot = await realpath(inbox);
  const candidate = resolve(source);
  if (dirname(candidate) !== inputRoot) throw new Error('Import only first-level inbox files');
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Input must be a regular file, not a symlink');
  if (dirname(await realpath(candidate)) !== inputRoot) throw new Error('Input outside inbox');
  const extension = extname(candidate).toLowerCase();
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error('Unsupported audio extension');
  if (info.size === 0 || info.size > maxBytes) throw new Error('Invalid audio file size');
  await mkdir(audioRoot, { recursive: true });
  const lock = join(audioRoot, '.import-lock');
  // One importer per library. A stale lock after a crash needs operator inspection.
  await mkdir(lock);
  const fileKey = `${randomUUID()}${extension}`;
  const temporary = join(audioRoot, `${fileKey}.part`);
  const destination = join(audioRoot, fileKey);
  let published = false;
  try {
    const space = await statfs(audioRoot);
    if (space.bavail * space.bsize - info.size < minFreeBytes) throw new Error('Insufficient free disk space');
    const total = await db.song.aggregate({ _sum: { byteSize: true } });
    if ((total._sum.byteSize ?? 0) + info.size > quotaBytes) throw new Error('Library quota exceeded');
    let bytes = 0;
    const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > info.size || bytes > maxBytes) return callback(new Error('Input grew during import'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(createReadStream(candidate), meter, createWriteStream(temporary, { flags: 'wx' }));
    if (bytes !== info.size) throw new Error('Input changed during import');
    const sha256 = hash.digest('hex');
    const duplicate = await db.song.findUnique({ where: { sha256 } });
    if (duplicate) return { status: 'duplicate' as const, id: duplicate.id };
    const metadata = await parseFile(temporary, { duration: true, skipCovers: true });
    if (!metadata.format.codec || !metadata.format.numberOfChannels) throw new Error('No recognized audio stream');
    const duration = metadata.format.duration;
    await rename(temporary, destination);
    const song = await db.song.create({ data: {
      fileKey, title: (labels.title?.trim() || metadata.common.title?.trim() || basename(labels.originalName ?? candidate, extname(labels.originalName ?? candidate))).slice(0, 500),
      artist: (labels.artist?.trim() || metadata.common.artist?.trim())?.slice(0, 500) || null,
      durationSeconds: duration && Number.isFinite(duration) && duration > 0 ? duration : null,
      mimeType, byteSize: bytes, sha256,
    } });
    published = true;
    return { status: 'imported' as const, id: song.id };
  } finally {
    await rm(temporary, { force: true });
    if (!published) await rm(destination, { force: true });
    await rm(lock, { recursive: true });
  }
}

export async function importInbox(options: ImportOptions) {
  const results: { file: string; status: string; id?: string; error?: string }[] = [];
  const root = await realpath(options.inbox);
  // Sequential, first level only; audio bytes are always streamed.
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !mimeTypes[extname(entry.name).toLowerCase()]) continue;
    try {
      results.push({ file: entry.name, ...await importFile(options, join(root, entry.name)) });
    } catch (error) {
      results.push({ file: entry.name, status: 'failed', error: (error as Error).message });
    }
  }
  return results;
}

