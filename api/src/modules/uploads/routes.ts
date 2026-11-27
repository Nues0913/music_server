import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { bearerAuth } from '../../shared/http/auth.js';
import { uploadFailure } from './errors.js';
import { uploadProcessingTimeoutMs, type UploadService, type UploadOptions } from './service.js';

export async function registerUpload(app: FastifyInstance, service: Pick<UploadService, 'upload' | 'getJob' | 'cancelJob'>, options: UploadOptions) {
  await app.register(multipart, { limits: { files: 1, fields: 2, parts: 3, fieldNameSize: 50,
    fieldSize: 2000, fileSize: options.maxBytes, headerPairs: 100 } });
  const authorization = { onRequest: bearerAuth(options.adminToken, '需要管理者上傳金鑰（ADMIN_TOKEN）') };
  app.get<{ Params: { id: string } }>('/v1/song-uploads/:id', authorization, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const job = service.getJob(request.params.id);
    return job ?? reply.code(404).send({ error: '查不到上傳紀錄，請確認歌曲是否已加入曲庫' });
  });
  app.delete<{ Params: { id: string } }>('/v1/song-uploads/:id', authorization, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!service.cancelJob(request.params.id)) return reply.code(404).send({ error: '查不到上傳紀錄' });
    return reply.code(204).send();
  });
  app.post('/v1/songs', authorization, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: '請使用 multipart/form-data 上傳' });
    const disconnected = new AbortController();
    const cancel = () => { if (!reply.raw.writableFinished) disconnected.abort(); };
    reply.raw.once('close', cancel);
    const socket = request.raw.socket;
    const previousTimeout = socket?.timeout;
    const extendTimeout = () => socket?.setTimeout?.(uploadProcessingTimeoutMs + 60_000);
    request.raw.once('end', extendTimeout);
    try {
      const prefer = request.headers.prefer;
      const background = typeof prefer === 'string' && prefer.split(',').some(value => value.trim().toLowerCase() === 'respond-async');
      const result = await service.upload(request.parts(), disconnected.signal, background);
      if (result.status === 202) {
        reply.header('Preference-Applied', 'respond-async').header('Cache-Control', 'no-store');
        reply.header('Location', `/v1/song-uploads/${result.body.jobId}`);
      }
      return reply.code(result.status).send(result.body);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      const failure = uploadFailure(error);
      if (failure.unexpected) request.log.error({ err: error }, 'Upload failed');
      else if (failure.status === 507) request.log.warn({ status: failure.status }, 'Upload capacity exhausted');
      else request.log.info({ status: failure.status }, 'Upload rejected');
      if (failure.retryAfter) reply.header('Retry-After', failure.retryAfter);
      return reply.code(failure.status).send({ error: failure.error });
    } finally {
      reply.raw.off('close', cancel);
      request.raw.off('end', extendTimeout);
      if (socket && !socket.destroyed) socket.setTimeout?.(previousTimeout ?? 0);
    }
  });
}
