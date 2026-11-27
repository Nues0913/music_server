import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient, Song } from '@prisma/client';
import { inspectImportSource } from '../../storage/importSource.js';
import { assertDiskCapacity, assertLibraryQuota, type CapacityLimits } from '../../storage/capacity.js';
import { audioMatches, copyAudio } from '../../storage/copyAudio.js';
import { fileKeyPattern } from '../../storage/audioFiles.js';
import { audioMimeType } from '../../storage/formats.js';
import { readSongMetadata, type ImportLabels } from './metadata.js';
import { normalizeUpload } from './loudness.js';

export type ImportOptions = CapacityLimits & { db: PrismaClient; audioRoot: string; inbox: string; };
type UploadSource = { sourceSha256: string; signal: AbortSignal };

async function storedAudio(root: string, song: Song) {
  if (!fileKeyPattern.test(song.fileKey)) throw new Error('Invalid stored audio key');
  const path = join(await realpath(root), song.fileKey);
  const entry = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Not a regular stored audio file');
  return { path, intact: Boolean(entry && await audioMatches(path, song.byteSize, song.sha256)) };
}

export async function importFile(options: ImportOptions, source: string, labels: ImportLabels = {}, upload?: UploadSource) {
  const { db, audioRoot } = options;
  const input = await inspectImportSource(options.inbox, source, options.maxBytes);
  await mkdir(audioRoot, { recursive: true });
  const lock = join(audioRoot, '.import-lock');
  // One importer owns publication and capacity checks. A crash lock needs operator inspection.
  await mkdir(lock);
  const fileKey = `${randomUUID()}${upload ? '.flac' : input.extension}`;
  const temporary = join(audioRoot, `${fileKey}.part`), destination = join(audioRoot, fileKey);
  let published = false;
  try {
    const copyInput = async () => {
      await assertDiskCapacity(audioRoot, input.size, options.minFreeBytes);
      return copyAudio(input.path, temporary, input.size, options.maxBytes);
    };
    if (upload) {
      upload.signal.throwIfAborted();
      const original = await db.song.findUnique({ where: { uploadSourceSha256: upload.sourceSha256 } });
      // An identical file already present from before normalization keeps its ID and original bytes.
      const existing = original ?? await db.song.findUnique({ where: { sha256: upload.sourceSha256 } });
      if (existing) {
        const stored = await storedAudio(audioRoot, existing);
        if (!stored.intact) {
          const replacement = original ? await normalizeUpload(input, temporary, audioRoot, options, upload.signal) : await copyInput();
          if (replacement.sha256 !== existing.sha256 || replacement.byteSize !== existing.byteSize) {
            throw new Error('Replacement does not match the registered audio fingerprint');
          }
          upload.signal.throwIfAborted();
          await rename(temporary, stored.path);
        }
        return { status: 'duplicate' as const, id: existing.id };
      }
    }
    const fingerprint = upload ? await normalizeUpload(input, temporary, audioRoot, options, upload.signal) : await copyInput();
    const duplicate = await db.song.findUnique({ where: { sha256: fingerprint.sha256 } });
    if (duplicate) {
      // Preserve ID, labels, status and file key when repairing missing/corrupted content.
      const stored = await storedAudio(audioRoot, duplicate);
      upload?.signal.throwIfAborted();
      if (!stored.intact) await rename(temporary, stored.path);
      return { status: 'duplicate' as const, id: duplicate.id };
    }
    await assertLibraryQuota(db, fingerprint.byteSize, options.quotaBytes);
    const metadata = await readSongMetadata(upload ? input.path : temporary, input.path, labels);
    upload?.signal.throwIfAborted();
    await rename(temporary, destination);
    const song = await db.song.create({ data: {
      fileKey, mimeType: upload ? 'audio/flac' : input.mimeType, uploadSourceSha256: upload?.sourceSha256,
      ...metadata, ...fingerprint,
    } });
    published = true;
    return { status: 'imported' as const, id: song.id };
  } finally {
    try {
      await rm(temporary, { force: true });
      if (!published) await rm(destination, { force: true });
    } finally { await rm(lock, { recursive: true }); }
  }
}

export async function importInbox(options: ImportOptions) {
  const results: { file: string; status: string; id?: string; error?: string }[] = [];
  const root = await realpath(options.inbox);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !audioMimeType(entry.name)) continue;
    try { results.push({ file: entry.name, ...await importFile(options, join(root, entry.name)) }); }
    catch (error) { results.push({ file: entry.name, status: 'failed', error: (error as Error).message }); }
  }
  return results;
}
