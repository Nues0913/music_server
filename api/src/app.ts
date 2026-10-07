import Fastify, { type FastifyError } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { resolveAudio } from './files.js';
import { registerPlaylists } from './playlists.js';
import { registerAdmin } from './admin.js';
import { registerUpload, type UploadOptions } from './upload.js';

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const paramsSchema = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', pattern: uuidPattern } },
};
const publicFields = {
  id: true, title: true, artist: true, durationSeconds: true,
  mimeType: true, byteSize: true, sha256: true, updatedAt: true,
} as const;

export function buildApp(options: { db: PrismaClient; token: string; audioRoot: string; logging?: boolean; upload?: UploadOptions; playlistToken?: string }) {
  const { db, token, audioRoot } = options;
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const app = Fastify({
    logger: options.logging ? { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] } : false,
    bodyLimit: 1024, requestTimeout: 900000, connectionTimeout: 60000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  if (options.playlistToken) {
    if (options.playlistToken.length < 32 || options.playlistToken === token || options.playlistToken === options.upload?.adminToken) throw new Error('Playlist token must be distinct and at least 32 characters');
    app.register(async scope => registerPlaylists(scope, db, options.playlistToken!), { prefix: '/v1' });
  }
  registerAdmin(app, options.upload?.maxBytes ?? 256 * 1024 * 1024, Boolean(options.upload));
  if (options.upload) {
    app.register(async scope => registerUpload(scope, db, audioRoot, options.upload!));
  }

  app.get('/health', async (_request, reply) => {
    try {
      await db.song.findFirst({ select: { id: true } });
      if (options.playlistToken) await db.playlist.findFirst({ select: { id: true } });
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(expected, actual)) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
      }
      reply.header('Cache-Control', 'no-store');
    });

    api.get<{ Querystring: { query?: string; cursor?: string; limit?: number } }>('/songs', {
      schema: { querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', maxLength: 200 },
          cursor: { type: 'string', pattern: uuidPattern },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 25 },
        },
      } },
    }, async (request) => {
      const { cursor, limit = 25 } = request.query;
      const query = request.query.query?.trim();
      const rows = await db.song.findMany({
        where: {
          status: 'active', ...(cursor ? { id: { gt: cursor } } : {}),
          ...(query ? { OR: [{ title: { contains: query } }, { artist: { contains: query } }] } : {}),
        },
        orderBy: { id: 'asc' }, take: limit + 1, select: publicFields,
      });
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
    });

    api.get<{ Params: { id: string } }>('/songs/:id', { schema: { params: paramsSchema } }, async (request, reply) => {
      const song = await db.song.findFirst({ where: { id: request.params.id, status: 'active' }, select: publicFields });
      return song ?? reply.code(404).send({ error: 'Song not found' });
    });

    api.get<{ Params: { id: string } }>('/songs/:id/audio', { schema: { params: paramsSchema } }, async (request, reply) => {
      const song = await db.song.findFirst({ where: { id: request.params.id, status: 'active' } });
      if (!song) return reply.code(404).send({ error: 'Song not found' });
      try {
        const path = await resolveAudio(audioRoot, song.fileKey);
        if ((await stat(path)).size !== song.byteSize) throw new Error('Size changed');
      } catch {
        return reply.code(404).send({ error: 'Audio unavailable' });
      }
      // Nginx sets the actual body length and handles HEAD/Range after internal redirect.
      return reply.header('X-Accel-Redirect', `/protected-audio/${song.fileKey}`)
        .type(song.mimeType).send();
    });
  }, { prefix: '/v1' });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) return reply.code(400).send({ error: 'Invalid request', details: error.validation });
    request.log.error({ err: error }, 'Request failed');
    return reply.code(503).send({ error: 'Service temporarily unavailable' });
  });
  return app;
}

