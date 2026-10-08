import type { FastifyInstance } from 'fastify';
import { bearerAuth } from '../../shared/http/auth.js';
import { idParams, uuidPattern } from '../../shared/http/schemas.js';
import { SongError, SongService, type SongQuery } from './service.js';

export function registerSongs(app: FastifyInstance, service: Pick<SongService, keyof SongService>, token: string) {
  app.addHook('onRequest', bearerAuth(token));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SongError) return reply.code(error.status).send({ error: error.message });
    throw error; // Delegate validation and unexpected failures to the app error handler.
  });
  app.get<{ Querystring: SongQuery }>('/songs', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 200 }, cursor: { type: 'string', pattern: uuidPattern },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 25 },
    } } },
  }, request => service.list(request.query));
  app.get<{ Params: { id: string } }>('/songs/:id', { schema: { params: idParams } }, request => service.get(request.params.id));
  app.get<{ Params: { id: string } }>('/songs/:id/audio', { schema: { params: idParams } }, async (request, reply) => {
    const audio = await service.audio(request.params.id);
    // Nginx owns response bytes, Content-Length, HEAD and Range handling.
    return reply.header('X-Accel-Redirect', `/protected-audio/${audio.fileKey}`).type(audio.mimeType).send();
  });
}
