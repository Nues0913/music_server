import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Multipart, MultipartFile } from '@fastify/multipart';
import { audioMimeType } from '../../storage/formats.js';
import { UploadError } from './errors.js';

async function writePart(part: MultipartFile, path: string, maxBytes: number, diskBudget: number) {
  let bytes = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(new UploadError(413, '音檔超過大小上限'));
    if (bytes > diskBudget) return callback(new UploadError(507, '磁碟可用空間不足'));
    callback(null, chunk);
  } });
  await pipeline(part.file, meter, createWriteStream(path, { flags: 'wx' }));
  if (part.file.truncated) throw new UploadError(413, '音檔超過大小上限');
  if (!bytes) throw new UploadError(400, '音檔不可為空');
}

export async function receiveMultipart(parts: AsyncIterable<Multipart>, staging: string, maxBytes: number, diskBudget: number) {
  let source: string | undefined, originalName = '';
  const labels: { title?: string; artist?: string } = {};
  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file' || source) throw new UploadError(400, '每次僅能上傳一個 file 欄位');
      originalName = basename(part.filename.replaceAll('\\', '/'));
      if (!audioMimeType(originalName)) throw new UploadError(415, '不支援此音檔格式');
      source = join(staging, `${randomUUID()}${extname(originalName).toLowerCase()}`);
      await writePart(part, source, maxBytes, diskBudget);
    } else {
      if (part.fieldname !== 'title' && part.fieldname !== 'artist') throw new UploadError(400, '僅接受 title 與 artist 欄位');
      if (labels[part.fieldname] !== undefined) throw new UploadError(400, '欄位不可重複');
      if (part.valueTruncated || typeof part.value !== 'string' || part.value.length > 500) throw new UploadError(400, '歌名與演出者各限 500 字元');
      labels[part.fieldname] = part.value.trim();
    }
  }
  if (!source) throw new UploadError(400, '缺少音檔 file 欄位');
  return { source, labels: { ...labels, originalName } };
}
