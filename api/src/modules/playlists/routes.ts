import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bearerAuth } from '../../shared/http/auth.js';
import type { PlaylistService } from './service.js';
import { playlistErrorHandler } from './errors.js';
import type { Track } from './model.js';
import * as schemas from './schemas.js';

type Id = { id: string };
type EntryId = Id & { entryId: string };
type Version = { revision: number };
const owner = (request: FastifyRequest) => request.headers['x-discord-user-id'] as string;

export function registerPlaylists(app: FastifyInstance, service: Pick<PlaylistService, keyof PlaylistService>, token: string): void {
  app.addHook('onRequest', bearerAuth(token, 'Unauthorized', false));
  app.addHook('onRequest', async (request, reply) => {
    if (typeof owner(request) !== 'string' || !/^[0-9]{17,20}$/.test(owner(request))) {
      return reply.code(400).send({ error: 'Valid X-Discord-User-Id required' });
    }
  });
  playlistErrorHandler(app);
  app.get('/playlists', async request => ({ items: await service.list(owner(request)) }));
  app.get<{ Params: Id }>('/playlists/:id', { schema: { params: schemas.idParams } },
    request => service.get(owner(request), request.params.id));
  app.post<{ Body: { name: string; tracks?: Track[] } }>('/playlists', {
    bodyLimit: 512 * 1024, schema: { body: schemas.createSchema },
  }, async (request, reply) => reply.code(201).send(await service.create(owner(request), request.body.name, request.body.tracks)));
  app.patch<{ Params: Id; Body: Version & { name: string } }>('/playlists/:id', {
    schema: { params: schemas.idParams, body: schemas.renameSchema },
  }, request => service.rename(owner(request), request.params.id, request.body.revision, request.body.name));
  app.delete<{ Params: Id; Body: Version }>('/playlists/:id', {
    schema: { params: schemas.idParams, body: schemas.deleteSchema },
  }, async (request, reply) => {
    await service.delete(owner(request), request.params.id, request.body.revision);
    return reply.code(204).send();
  });
  app.post<{ Params: Id; Body: Version & { tracks: Track[] } }>('/playlists/:id/entries', {
    bodyLimit: 512 * 1024, schema: { params: schemas.idParams, body: schemas.addSchema },
  }, request => service.add(owner(request), request.params.id, request.body.revision, request.body.tracks));
  app.delete<{ Params: EntryId; Body: Version }>('/playlists/:id/entries/:entryId', {
    schema: { params: schemas.entryParams, body: schemas.deleteSchema },
  }, request => service.remove(owner(request), request.params.id, request.body.revision, request.params.entryId));
  app.patch<{ Params: EntryId; Body: Version & { position: number } }>('/playlists/:id/entries/:entryId', {
    schema: { params: schemas.entryParams, body: schemas.moveSchema },
  }, request => service.move(owner(request), request.params.id, request.body.revision, request.params.entryId, request.body.position));
}
