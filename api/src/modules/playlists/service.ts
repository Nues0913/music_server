import type { Prisma, PrismaClient } from '@prisma/client';
import { createEntries, includeEntries, maxPlaylistRevision, moveEntry, normalizeName, playlistLimits,
  PlaylistError, presentPlaylist, type PlaylistRow, type Track } from './model.js';

type Transaction = Prisma.TransactionClient;
export class PlaylistService {
  constructor(private readonly db: PrismaClient) {}

  private async owned(tx: Transaction, ownerId: string, id: string): Promise<PlaylistRow> {
    const row = await tx.playlist.findFirst({ where: { id, ownerId }, include: includeEntries });
    if (!row) throw new PlaylistError(404, '找不到你的播放清單。');
    return row;
  }

  private mutate(ownerId: string, id: string, revision: number,
    action: (tx: Transaction, row: PlaylistRow) => Promise<void>) {
    return this.db.$transaction(async tx => {
      const row = await this.owned(tx, ownerId, id);
      if (row.revision === revision && revision >= maxPlaylistRevision) {
        throw new PlaylistError(409, '清單版本已達上限，請另存為新清單後操作；仍可刪除此清單。');
      }
      // Claim this aggregate version before changing entries. Any later error rolls back the claim.
      const changed = await tx.playlist.updateMany({ where: { id, ownerId, revision }, data: { revision: { increment: 1 } } });
      if (!changed.count) throw new PlaylistError(409, '清單已更新，請重新讀取後操作。');
      await action(tx, row);
      return presentPlaylist(await this.owned(tx, ownerId, id));
    });
  }

  async list(ownerId: string) {
    const rows = await this.db.playlist.findMany({ where: { ownerId }, orderBy: { id: 'asc' }, include: includeEntries });
    return rows.map(presentPlaylist);
  }
  async get(ownerId: string, id: string) { return presentPlaylist(await this.owned(this.db, ownerId, id)); }
  async create(ownerId: string, value: string, tracks: Track[] = []) {
    const name = normalizeName(value), entries = createEntries(tracks);
    const row = await this.db.$transaction(async tx => {
      if (await tx.playlist.count({ where: { ownerId } }) >= playlistLimits.perOwner) {
        throw new PlaylistError(409, '每人最多 20 份清單。');
      }
      return tx.playlist.create({ data: { ...name, ownerId, entries: { create: entries } }, include: includeEntries });
    });
    return presentPlaylist(row);
  }
  rename(ownerId: string, id: string, revision: number, name: string) {
    return this.mutate(ownerId, id, revision, async tx => {
      await tx.playlist.update({ where: { id }, data: normalizeName(name) });
    });
  }
  async delete(ownerId: string, id: string, revision: number) {
    await this.db.$transaction(async tx => {
      await this.owned(tx, ownerId, id);
      const deleted = await tx.playlist.deleteMany({ where: { id, ownerId, revision } });
      if (!deleted.count) throw new PlaylistError(409, '清單已更新，請重新確認刪除。');
    });
  }
  add(ownerId: string, id: string, revision: number, tracks: Track[]) {
    return this.mutate(ownerId, id, revision, async (tx, row) => {
      if (row.entries.length + tracks.length > playlistLimits.entries) {
        throw new PlaylistError(409, '每份清單最多 100 首，未加入任何歌曲。');
      }
      await tx.playlistEntry.createMany({ data: createEntries(tracks, row.entries.length).map(entry => ({ ...entry, playlistId: id })) });
    });
  }
  private async savePositions(tx: Transaction, entries: { entryId: string }[]) {
    for (const [position, entry] of entries.entries()) {
      await tx.playlistEntry.update({ where: { entryId: entry.entryId }, data: { position } });
    }
  }
  remove(ownerId: string, id: string, revision: number, entryId: string) {
    return this.mutate(ownerId, id, revision, async (tx, row) => {
      if (!row.entries.some(entry => entry.entryId === entryId)) throw new PlaylistError(404, '此項目已不在清單中。');
      await tx.playlistEntry.delete({ where: { entryId } });
      await this.savePositions(tx, row.entries.filter(entry => entry.entryId !== entryId));
    });
  }
  move(ownerId: string, id: string, revision: number, entryId: string, position: number) {
    return this.mutate(ownerId, id, revision, async (tx, row) => {
      await this.savePositions(tx, moveEntry(row.entries, entryId, position));
    });
  }
}
