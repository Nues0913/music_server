import multipart from '@fastify/multipart';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { importFile } from './importer.js';

export type UploadOptions = {
  adminToken: string; maxBytes: number; minFreeBytes: number; quotaBytes: number;
};
class UploadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function registerUpload(app: FastifyInstance, db: PrismaClient, audioRoot: string, options: UploadOptions) {
  const expected = createHash('sha256').update(`Bearer ${options.adminToken}`).digest();
  let uploading = false;
  await app.register(multipart, {
    limits: { files: 1, fields: 2, parts: 3, fieldNameSize: 50, fieldSize: 2000, fileSize: options.maxBytes, headerPairs: 100 },
  });
  app.post('/v1/songs', {
    onRequest: async (request, reply) => {
      const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(actual, expected)) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: '需要管理者上傳金鑰（ADMIN_TOKEN）' });
      }
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.isMultipart()) return reply.code(415).send({ error: '請使用 multipart/form-data 上傳' });
    if (uploading) return reply.code(409).header('Retry-After', '5').send({ error: '已有上傳正在處理，請稍後再試' });
    uploading = true;
    let staging: string | undefined;
    let responseStatus = 500;
    let responseBody: unknown;
    try {
      const stagingRoot = join(audioRoot, '.uploads');
      await mkdir(stagingRoot, { recursive: true });
      const space = await statfs(audioRoot);
      // Reserve room for staging and the import copy, plus the configured free-space floor.
      const diskBudget = Math.floor((space.bavail * space.bsize - options.minFreeBytes) / 2);
      if (diskBudget <= 0) throw new UploadError(507, '磁碟可用空間不足');
      staging = await mkdtemp(join(stagingRoot, 'upload-'));
      let source: string | undefined;
      let originalName = '';
      const labels: { title?: string; artist?: string } = {};
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || source) throw new UploadError(400, '每次僅能上傳一個 file 欄位');
          originalName = basename(part.filename.replaceAll('\\', '/'));
          const extension = extname(originalName).toLowerCase();
          if (!['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.webm'].includes(extension)) {
            throw new UploadError(415, '不支援此音檔格式');
          }
          source = join(staging, `${randomUUID()}${extension}`);
          let bytes = 0;
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > options.maxBytes) return callback(new UploadError(413, '音檔超過大小上限'));
            if (bytes > diskBudget) return callback(new UploadError(507, '磁碟可用空間不足'));
            callback(null, chunk);
          } });
          await pipeline(part.file, meter, createWriteStream(source, { flags: 'wx' }));
          if (part.file.truncated) throw new UploadError(413, '音檔超過大小上限');
          if (bytes === 0) throw new UploadError(400, '音檔不可為空');
        } else {
          if (part.fieldname !== 'title' && part.fieldname !== 'artist') throw new UploadError(400, '僅接受 title 與 artist 欄位');
          if (labels[part.fieldname] !== undefined) throw new UploadError(400, '欄位不可重複');
          if (part.valueTruncated || typeof part.value !== 'string' || part.value.length > 500) {
            throw new UploadError(400, '歌名與演出者各限 500 字元');
          }
          labels[part.fieldname] = part.value.trim();
        }
      }
      if (!source) throw new UploadError(400, '缺少音檔 file 欄位');
      const result = await importFile({ ...options, db, audioRoot, inbox: staging }, source, { ...labels, originalName });
      const song = await db.song.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, title: true, artist: true, status: true } });
      responseStatus = result.status === 'imported' ? 201 : 200;
      responseBody = { ...result, song };
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (error instanceof UploadError) {
        responseStatus = error.status; responseBody = { error: error.message };
      } else if (failure.code === 'FST_REQ_FILE_TOO_LARGE') {
        responseStatus = 413; responseBody = { error: '音檔超過大小上限' };
      } else if (failure.code?.startsWith('FST_') || failure.message.includes('Multipart')) {
        responseStatus = 400; responseBody = { error: '上傳格式或欄位不正確' };
      } else if (failure.code === 'EEXIST') {
        responseStatus = 409; responseBody = { error: '曲庫正在匯入，請稍後再試' };
      } else if (failure.code === 'ENOSPC' || /disk space|quota exceeded/.test(failure.message)) {
        responseStatus = 507; responseBody = { error: '磁碟空間或曲庫配額不足' };
      } else {
        request.log.warn({ err: error }, 'Upload failed');
        responseStatus = 400; responseBody = { error: '無法匯入音檔，請確認檔案完整且為有效音訊' };
      }
    } finally {
      try { if (staging) await rm(staging, { recursive: true, force: true }); }
      finally { uploading = false; }
    }
    return reply.code(responseStatus).send(responseBody);
  });
}
