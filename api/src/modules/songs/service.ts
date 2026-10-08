import { stat } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { resolveAudio } from '../../storage/audioFiles.js';

const publicFields = { id: true, title: true, artist: true, durationSeconds: true,
  mimeType: true, byteSize: true, sha256: true, updatedAt: true } as const;
export interface SongQuery { query?: string; cursor?: string; limit?: number; }
export class SongError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export class SongService {
  constructor(private readonly db: PrismaClient, private readonly audioRoot: string) {}
  async list({ query: rawQuery, cursor, limit = 25 }: SongQuery) {
    const query = rawQuery?.trim();
    const rows = await this.db.song.findMany({
      where: { status: 'active', ...(cursor ? { id: { gt: cursor } } : {}),
        ...(query ? { OR: [{ title: { contains: query } }, { artist: { contains: query } }] } : {}) },
      orderBy: { id: 'asc' }, take: limit + 1, select: publicFields,
    });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }
  async get(id: string) {
    const song = await this.db.song.findFirst({ where: { id, status: 'active' }, select: publicFields });
    if (!song) throw new SongError(404, 'Song not found');
    return song;
  }
  async audio(id: string) {
    const song = await this.db.song.findFirst({ where: { id, status: 'active' } });
    if (!song) throw new SongError(404, 'Song not found');
    try {
      const path = await resolveAudio(this.audioRoot, song.fileKey);
      if ((await stat(path)).size !== song.byteSize) throw new Error('Size changed');
    } catch { throw new SongError(404, 'Audio unavailable'); }
    return { fileKey: song.fileKey, mimeType: song.mimeType };
  }
}
