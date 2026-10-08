import { Prisma } from '@prisma/client';
import type { FastifyError, FastifyInstance } from 'fastify';
import { PlaylistError } from './model.js';

export function playlistErrorHandler(app: FastifyInstance) {
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
}
