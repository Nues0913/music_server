import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { bearerAuth } from '../../shared/http/auth.js';
import { uploadFailure } from './errors.js';
import { UploadService, type UploadOptions } from './service.js';

export async function registerUpload(app: FastifyInstance, service: Pick<UploadService, 'upload'>, options: UploadOptions) {
  await app.register(multipart, { limits: { files: 1, fields: 2, parts: 3, fieldNameSize: 50,
    fieldSize: 2000, fileSize: options.maxBytes, headerPairs: 100 } });
  app.post('/v1/songs', { onRequest: bearerAuth(options.adminToken, '需要管理者上傳金鑰（ADMIN_TOKEN）') }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: '請使用 multipart/form-data 上傳' });
    try {
      const result = await service.upload(request.parts());
      return reply.code(result.status).send(result.body);
    } catch (error) {
      const failure = uploadFailure(error);
      if (failure.unexpected) request.log.error({ err: error }, 'Upload failed');
      else if (failure.status === 507) request.log.warn({ status: failure.status }, 'Upload capacity exhausted');
      else request.log.info({ status: failure.status }, 'Upload rejected');
      if (failure.retryAfter) reply.header('Retry-After', failure.retryAfter);
      return reply.code(failure.status).send({ error: failure.error });
    }
  });
}
