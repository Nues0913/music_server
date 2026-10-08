import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { inspectImportSource } from '../../storage/importSource.js';
import { assertDiskCapacity, assertLibraryQuota, type CapacityLimits } from '../../storage/capacity.js';
import { audioMatches, copyAudio } from '../../storage/copyAudio.js';
import { fileKeyPattern } from '../../storage/audioFiles.js';
import { audioMimeType } from '../../storage/formats.js';
import { readSongMetadata, type ImportLabels } from './metadata.js';

export type ImportOptions = CapacityLimits & { db: PrismaClient; audioRoot: string; inbox: string; };
export async function importFile(options: ImportOptions, source: string, labels: ImportLabels = {}) {
  const { db, audioRoot } = options;
  const input = await inspectImportSource(options.inbox, source, options.maxBytes);
  await mkdir(audioRoot, { recursive: true });
  const lock = join(audioRoot, '.import-lock');
  // One importer owns publication and capacity checks. A crash lock needs operator inspection.
  await mkdir(lock);
  const fileKey = `${randomUUID()}${input.extension}`;
  const temporary = join(audioRoot, `${fileKey}.part`), destination = join(audioRoot, fileKey);
  let published = false;
  try {
    await assertDiskCapacity(audioRoot, input.size, options.minFreeBytes);
    const fingerprint = await copyAudio(input.path, temporary, input.size, options.maxBytes);
    const duplicate = await db.song.findUnique({ where: { sha256: fingerprint.sha256 } });
    if (duplicate) {
      // Preserve ID, labels, status and file key when repairing missing/corrupted content.
      if (!fileKeyPattern.test(duplicate.fileKey)) throw new Error('Invalid stored audio key');
      const existing = join(await realpath(audioRoot), duplicate.fileKey);
      const entry = await lstat(existing).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Not a regular stored audio file');
      if (!entry || !await audioMatches(existing, fingerprint.byteSize, fingerprint.sha256)) await rename(temporary, existing);
      return { status: 'duplicate' as const, id: duplicate.id };
    }
    await assertLibraryQuota(db, input.size, options.quotaBytes);
    const metadata = await readSongMetadata(temporary, input.path, labels);
    await rename(temporary, destination);
    const song = await db.song.create({ data: { fileKey, mimeType: input.mimeType, ...fingerprint, ...metadata } });
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
