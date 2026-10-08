import Fastify, { type FastifyError } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerPlaylists } from './modules/playlists/routes.js';
import { PlaylistService } from './modules/playlists/service.js';
import { registerSongs } from './modules/songs/routes.js';
import { SongService } from './modules/songs/service.js';
import { registerAdmin } from './modules/admin/routes.js';
import { registerUpload } from './modules/uploads/routes.js';
import { UploadService, type UploadOptions } from './modules/uploads/service.js';

export interface AppOptions {
  db: PrismaClient; token: string; audioRoot: string; logging?: boolean;
  upload?: UploadOptions;
}
export function buildApp(options: AppOptions) {
  const { db, token, audioRoot, upload } = options;
  const app = Fastify({
    logger: options.logging ? { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] } : false,
    bodyLimit: 1024, requestTimeout: 900000, connectionTimeout: 60000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) return reply.code(400).send({ error: 'Invalid request', details: error.validation });
    request.log.error({ err: error }, 'Request failed');
    return reply.code(503).send({ error: 'Service temporarily unavailable' });
  });
  registerAdmin(app, upload?.maxBytes ?? 256 * 1024 * 1024, Boolean(upload));
  app.register(async scope => registerSongs(scope, new SongService(db, audioRoot), token), { prefix: '/v1' });
  app.register(async scope => registerPlaylists(scope, new PlaylistService(db), token), { prefix: '/v1' });
  if (upload) app.register(async scope => registerUpload(scope, new UploadService(db, audioRoot, upload), upload));
  app.get('/health', async (_request, reply) => {
    try {
      await db.song.findFirst({ select: { id: true } });
      await db.playlist.findFirst({ select: { id: true } });
      return { status: 'ok' };
    } catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  return app;
}
