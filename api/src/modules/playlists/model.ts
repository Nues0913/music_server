import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { uuidPattern } from '../../shared/http/schemas.js';

export const playlistLimits = { perOwner: 20, entries: 100, name: 60 } as const;
export const maxPlaylistRevision = 2_147_483_647;
export const includeEntries = { entries: { orderBy: { position: 'asc' as const } } };
export type PlaylistRow = Prisma.PlaylistGetPayload<{ include: typeof includeEntries }>;
export interface Track { source: 'local' | 'remote'; id: string; title: string; artist?: string; library?: string; }
export class PlaylistError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function normalizeName(value: string) {
  const name = value.normalize('NFKC').trim();
  if (!name || name.length > playlistLimits.name || /[\x00-\x1f]/.test(name)) {
    throw new PlaylistError(400, '清單名稱須為 1–60 字且不可換行。');
  }
  return { name, nameKey: name.toLowerCase() };
}

function validateTrack(track: Track): void {
  if (track.source === 'remote' && (!new RegExp(uuidPattern).test(track.id) || !track.library)) {
    throw new PlaylistError(400, '遠端歌曲需要有效 ID 與曲庫網址。');
  }
  if (!track.library) return;
  let url: URL;
  try { url = new URL(track.library); } catch { throw new PlaylistError(400, '曲庫網址無效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new PlaylistError(400, '曲庫網址不可包含憑證、查詢參數或片段。');
  }
}

export function createEntries(tracks: Track[], offset = 0) {
  return tracks.map((track, index) => {
    validateTrack(track);
    return { entryId: randomUUID(), position: offset + index, source: track.source,
      trackId: track.id, title: track.title, artist: track.artist, library: track.library };
  });
}

export function moveEntry<T extends { entryId: string }>(entries: T[], entryId: string, position: number): T[] {
  const index = entries.findIndex(entry => entry.entryId === entryId);
  if (index < 0) throw new PlaylistError(404, '此項目已不在清單中。');
  if (position < 1 || position > entries.length) throw new PlaylistError(400, '目標位置超出清單範圍。');
  const reordered = [...entries];
  const [entry] = reordered.splice(index, 1);
  reordered.splice(position - 1, 0, entry!);
  return reordered;
}

export function presentPlaylist(row: PlaylistRow) {
  return { id: row.id, ownerId: row.ownerId, name: row.name, revision: row.revision,
    entries: row.entries.map(entry => ({ entryId: entry.entryId, source: entry.source, id: entry.trackId,
      title: entry.title, ...(entry.artist ? { artist: entry.artist } : {}), ...(entry.library ? { library: entry.library } : {}) })) };
}
