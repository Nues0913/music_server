import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Multipart } from '@fastify/multipart';
import { uploadDiskBudget, type CapacityLimits } from '../../storage/capacity.js';
import { importFile } from '../ingestion/importer.js';
import { receiveMultipart } from './multipart.js';
import { UploadError } from './errors.js';

export type UploadOptions = CapacityLimits & { adminToken: string; };
export class UploadService {
  private uploading = false;
  constructor(private readonly db: PrismaClient, private readonly audioRoot: string, private readonly limits: CapacityLimits) {}
  async upload(parts: AsyncIterable<Multipart>) {
    if (this.uploading) throw new UploadError(409, '已有上傳正在處理，請稍後再試', '5');
    this.uploading = true;
    let staging: string | undefined;
    try {
      const stagingRoot = join(this.audioRoot, '.uploads');
      await mkdir(stagingRoot, { recursive: true });
      const diskBudget = await uploadDiskBudget(this.audioRoot, this.limits.minFreeBytes);
      if (diskBudget <= 0) throw new UploadError(507, '磁碟可用空間不足');
      staging = await mkdtemp(join(stagingRoot, 'upload-'));
      const { source, labels } = await receiveMultipart(parts, staging, this.limits.maxBytes, diskBudget);
      const result = await importFile({ ...this.limits, db: this.db, audioRoot: this.audioRoot, inbox: staging }, source, labels);
      const song = await this.db.song.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, title: true, artist: true, status: true } });
      return { status: result.status === 'imported' ? 201 : 200, body: { ...result, song } };
    } finally {
      try { if (staging) await rm(staging, { recursive: true, force: true }); }
      finally { this.uploading = false; }
    }
  }
}
