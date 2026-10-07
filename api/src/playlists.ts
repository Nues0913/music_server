import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyError } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const revisionSchema = { type: 'integer', minimum: 1, maximum: 2147483646 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const trackProperties = {
  source: { enum: ['local', 'remote'] }, id: string(128), title: string(500), artist: string(500), library: string(2048),
};
const trackSchema = object(trackProperties, ['source', 'id', 'title']);
const entrySchema = object({ ...trackProperties, entryId: { type: 'string', pattern: uuid } }, ['source', 'id', 'title', 'entryId']);
const tracksSchema = { type: 'array', maxItems: 100, items: trackSchema };
const idParams = object({ id: { type: 'string', pattern: uuid } });
const entryParams = object({ id: { type: 'string', pattern: uuid }, entryId: { type: 'string', pattern: uuid } });
const includeEntries = { entries: { orderBy: { position: 'asc' as const } } };
type Row = Prisma.PlaylistGetPayload<{ include: typeof includeEntries }>;
interface Track { source: 'local' | 'remote'; id: string; title: string; artist?: string; library?: string; entryId?: string; }
interface ImportBody { name: string; revision: number; entries: (Track & { entryId: string })[]; }
class PlaylistError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function name(value: string): { name: string; nameKey: string } {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 60 || /[\x00-\x1f]/.test(normalized)) throw new PlaylistError(400, '清單名稱須為 1–60 字且不可換行。');
  return { name: normalized, nameKey: normalized.toLowerCase() };
}
function entries(tracks: Track[], offset = 0) {
  return tracks.map((track, index) => {
    if (track.source === 'remote') {
      if (!new RegExp(uuid).test(track.id) || !track.library) throw new PlaylistError(400, '遠端歌曲需要有效 ID 與曲庫網址。');
    }
    if (track.library) {
      let url: URL;
      try { url = new URL(track.library); } catch { throw new PlaylistError(400, '曲庫網址無效。'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new PlaylistError(400, '曲庫網址不可包含憑證、查詢參數或片段。');
      }
    }
    return { entryId: track.entryId ?? randomUUID(), position: offset + index,
      source: track.source, trackId: track.id, title: track.title, artist: track.artist, library: track.library };
  });
}
function present(row: Row) {
  return { id: row.id, ownerId: row.ownerId, name: row.name, revision: row.revision,
    entries: row.entries.map(e => ({ entryId: e.entryId, source: e.source, id: e.trackId, title: e.title,
      ...(e.artist ? { artist: e.artist } : {}), ...(e.library ? { library: e.library } : {}) })) };
}
const owner = (request: FastifyRequest) => request.headers['x-discord-user-id'] as string;

export function registerPlaylists(app: FastifyInstance, db: PrismaClient, token: string): void {
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  app.addHook('onRequest', async (request, reply) => {
    const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: 'Unauthorized' });
    if (typeof owner(request) !== 'string' || !/^[0-9]{17,20}$/.test(owner(request))) {
      return reply.code(400).send({ error: 'Valid X-Discord-User-Id required' });
    }
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PlaylistError) return reply.code(error.status).send({ error: error.message });
    const failure = error as FastifyError;
    if (failure.validation || failure.statusCode === 400) return reply.code(400).send({ error: 'Invalid playlist request' });
    if (failure.statusCode === 413) return reply.code(413).send({ error: 'Playlist request too large' });
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034', 'P2028', 'P1008'].includes(error.code)) {
      return reply.code(409).send({ error: error.code === 'P2002' ? '清單名稱或項目 ID 已存在。' : '資料剛剛已變更，請重新讀取後操作。' });
    }
    request.log.error({ err: error }, 'Playlist request failed');
    return reply.code(503).send({ error: 'Playlist service unavailable' });
  });
  async function owned(tx: Prisma.TransactionClient, user: string, id: string) {
    const row = await tx.playlist.findFirst({ where: { id, ownerId: user }, include: includeEntries });
    if (!row) throw new PlaylistError(404, '找不到你的播放清單。');
    return row;
  }
  async function quota(tx: Prisma.TransactionClient, user: string) {
    if (await tx.playlist.count({ where: { ownerId: user } }) >= 20) throw new PlaylistError(409, '每人最多 20 份清單。');
  }
  async function mutate(user: string, id: string, revision: number, action: (tx: Prisma.TransactionClient, row: Row) => Promise<void>) {
    return db.$transaction(async tx => {
      const row = await owned(tx, user, id);
      const changed = await tx.playlist.updateMany({ where: { id, ownerId: user, revision }, data: { revision: { increment: 1 } } });
      if (!changed.count) throw new PlaylistError(409, '清單已更新，請重新讀取後操作。');
      await action(tx, row);
      return present(await owned(tx, user, id));
    });
  }
  app.get('/playlists', async request => ({ items: (await db.playlist.findMany({ where: { ownerId: owner(request) }, orderBy: { id: 'asc' }, include: includeEntries })).map(present) }));
  app.get<{ Params: { id: string } }>('/playlists/:id', { schema: { params: idParams } }, async request => present(await owned(db, owner(request), request.params.id)));
  app.post<{ Body: { name: string; tracks?: Track[] } }>('/playlists', {
    bodyLimit: 512 * 1024, schema: { body: object({ name: string(60), tracks: tracksSchema }, ['name']) },
  }, async (request, reply) => {
    const data = name(request.body.name), items = entries(request.body.tracks ?? []);
    const result = await db.$transaction(async tx => {
      await quota(tx, owner(request));
      return tx.playlist.create({ data: { ...data, ownerId: owner(request), entries: { create: items } }, include: includeEntries });
    });
    return reply.code(201).send(present(result));
  });
  app.patch<{ Params: { id: string }; Body: { name: string; revision: number } }>('/playlists/:id', {
    schema: { params: idParams, body: object({ name: string(60), revision: revisionSchema }) },
  }, request => mutate(owner(request), request.params.id, request.body.revision, async tx => {
    await tx.playlist.update({ where: { id: request.params.id }, data: name(request.body.name) });
  }));
  app.delete<{ Params: { id: string }; Body: { revision: number } }>('/playlists/:id', {
    schema: { params: idParams, body: object({ revision: revisionSchema }) },
  }, async (request, reply) => {
    await db.$transaction(async tx => {
      await owned(tx, owner(request), request.params.id);
      const result = await tx.playlist.deleteMany({ where: { id: request.params.id, ownerId: owner(request), revision: request.body.revision } });
      if (!result.count) throw new PlaylistError(409, '清單已更新，請重新確認刪除。');
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { tracks: Track[]; revision: number } }>('/playlists/:id/entries', {
    bodyLimit: 512 * 1024, schema: { params: idParams, body: object({ tracks: { ...tracksSchema, minItems: 1 }, revision: revisionSchema }) },
  }, request => mutate(owner(request), request.params.id, request.body.revision, async (tx, row) => {
    if (row.entries.length + request.body.tracks.length > 100) throw new PlaylistError(409, '每份清單最多 100 首，未加入任何歌曲。');
    const data = entries(request.body.tracks, row.entries.length).map(e => ({ ...e, playlistId: row.id }));
    await tx.playlistEntry.createMany({ data });
  }));
  app.delete<{ Params: { id: string; entryId: string }; Body: { revision: number } }>('/playlists/:id/entries/:entryId', {
    schema: { params: entryParams, body: object({ revision: revisionSchema }) },
  }, request => mutate(owner(request), request.params.id, request.body.revision, async (tx, row) => {
    if (!row.entries.some(e => e.entryId === request.params.entryId)) throw new PlaylistError(404, '此項目已不在清單中。');
    await tx.playlistEntry.delete({ where: { entryId: request.params.entryId } });
    const remaining = row.entries.filter(e => e.entryId !== request.params.entryId);
    for (const [position, entry] of remaining.entries()) await tx.playlistEntry.update({ where: { entryId: entry.entryId }, data: { position } });
  }));
  app.patch<{ Params: { id: string; entryId: string }; Body: { revision: number; position: number } }>('/playlists/:id/entries/:entryId', {
    schema: { params: entryParams, body: object({ revision: revisionSchema, position: { type: 'integer', minimum: 1, maximum: 100 } }) },
  }, request => mutate(owner(request), request.params.id, request.body.revision, async (tx, row) => {
    const index = row.entries.findIndex(e => e.entryId === request.params.entryId);
    if (index < 0) throw new PlaylistError(404, '此項目已不在清單中。');
    if (request.body.position > row.entries.length) throw new PlaylistError(400, '目標位置超出清單範圍。');
    const [entry] = row.entries.splice(index, 1); row.entries.splice(request.body.position - 1, 0, entry!);
    for (const [position, item] of row.entries.entries()) await tx.playlistEntry.update({ where: { entryId: item.entryId }, data: { position } });
  }));
  app.put<{ Params: { id: string }; Body: ImportBody }>('/playlists/:id/import', {
    bodyLimit: 512 * 1024, schema: { params: idParams, body: object({ name: string(60), revision: revisionSchema, entries: { type: 'array', maxItems: 100, items: entrySchema } }) },
  }, async request => {
    const data = name(request.body.name), items = entries(request.body.entries);
    const hash = createHash('sha256').update(JSON.stringify({ ...data, revision: request.body.revision, items })).digest('hex');
    return db.$transaction(async tx => {
      const existing = await tx.playlist.findUnique({ where: { id: request.params.id }, include: includeEntries });
      if (existing) {
        if (existing.ownerId !== owner(request)) throw new PlaylistError(404, '找不到你的播放清單。');
        if (existing.importHash !== hash) throw new PlaylistError(409, '此 ID 已存在，匯入未覆寫資料。');
        return present(existing);
      }
      await quota(tx, owner(request));
      return present(await tx.playlist.create({ data: { id: request.params.id, ownerId: owner(request), ...data,
        revision: request.body.revision, importHash: hash, entries: { create: items } }, include: includeEntries }));
    });
  });
}
