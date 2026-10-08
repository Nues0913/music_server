import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { inspectImportSource } from '../../storage/importSource.js';
import { assertImportCapacity, type CapacityLimits } from '../../storage/capacity.js';
import { copyAudio } from '../../storage/copyAudio.js';
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
    await assertImportCapacity(db, audioRoot, input.size, options);
    const fingerprint = await copyAudio(input.path, temporary, input.size, options.maxBytes);
    const duplicate = await db.song.findUnique({ where: { sha256: fingerprint.sha256 } });
    if (duplicate) return { status: 'duplicate' as const, id: duplicate.id };
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
