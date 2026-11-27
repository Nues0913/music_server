import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Multipart } from '@fastify/multipart';
import { uploadDiskBudget, type CapacityLimits } from '../../storage/capacity.js';
import { importFile } from '../ingestion/importer.js';
import { receiveMultipart } from './multipart.js';
import { UploadError, uploadFailure } from './errors.js';

export type UploadOptions = CapacityLimits & { adminToken: string; };
export const uploadProcessingTimeoutMs = 10 * 60_000;
const jobRetentionMs = 30 * 60_000;
const maxStoredJobs = 64;
type StagedUpload = Awaited<ReturnType<typeof receiveMultipart>>;
type UploadResult = { status: 200 | 201; body: {
  status: 'imported' | 'duplicate'; id: string;
  song: { id: string; title: string; artist: string | null; status: string };
} };
type JobStatus = { state: 'processing' | 'cancelled' } | { state: 'complete'; result: UploadResult['body'] } |
  { state: 'failed'; status: number; error: string };
type Job = { controller: AbortController; status: JobStatus; finishedAt?: number };

export class UploadService {
  private uploading = false;
  private readonly jobs = new Map<string, Job>();
  private background?: { controller: AbortController; done: Promise<void> };
  constructor(private readonly db: PrismaClient, private readonly audioRoot: string, private readonly limits: CapacityLimits,
    private readonly reportFailure: (error: unknown) => void = () => {}) {}

  private pruneJobs() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && (now - job.finishedAt >= jobRetentionMs || this.jobs.size > maxStoredJobs)) {
        this.jobs.delete(id);
      }
    }
  }

  getJob(id: string) {
    this.pruneJobs();
    return this.jobs.get(id)?.status;
  }

  cancelJob(id: string) {
    this.pruneJobs();
    const job = this.jobs.get(id);
    if (job?.status.state === 'processing') job.controller.abort();
    return Boolean(job);
  }

  async close() {
    const background = this.background;
    background?.controller.abort();
    await background?.done;
  }

  private async process(staging: string, upload: StagedUpload, cancelled: AbortSignal): Promise<UploadResult> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(uploadProcessingTimeoutMs)]);
    const { source, labels, sourceSha256 } = upload;
    const result = await importFile({ ...this.limits, db: this.db, audioRoot: this.audioRoot, inbox: staging },
      source, labels, { sourceSha256, signal });
    const song = await this.db.song.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, title: true, artist: true, status: true } });
    return { status: result.status === 'imported' ? 201 : 200, body: { ...result, song } };
  }

  private async release(staging?: string) {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { this.uploading = false; }
  }

  private async completeJob(job: Job, staging: string, upload: StagedUpload) {
    let status: JobStatus;
    try {
      const result = await this.process(staging, upload, job.controller.signal);
      status = { state: 'complete', result: result.body };
    } catch (error) {
      if (job.controller.signal.aborted) status = { state: 'cancelled' };
      else {
        const failure = uploadFailure(error);
        if (failure.unexpected) this.reportFailure(error);
        status = { state: 'failed', status: failure.status, error: failure.error };
      }
    } finally {
      await this.release(staging).catch(error => this.reportFailure(error));
      this.background = undefined;
    }
    // Pollers can start the next song immediately once a result is visible.
    job.status = status;
    job.finishedAt = Date.now();
  }

  async upload(parts: AsyncIterable<Multipart>, disconnected: AbortSignal, background = false) {
    if (this.uploading) throw new UploadError(409, '已有上傳正在處理，請稍後再試', '5');
    this.uploading = true;
    let staging: string | undefined;
    let handedOff = false;
    try {
      const stagingRoot = join(this.audioRoot, '.uploads');
      await mkdir(stagingRoot, { recursive: true });
      const diskBudget = await uploadDiskBudget(this.audioRoot, this.limits.minFreeBytes);
      if (diskBudget <= 0) throw new UploadError(507, '磁碟可用空間不足');
      staging = await mkdtemp(join(stagingRoot, 'upload-'));
      const upload = await receiveMultipart(parts, staging, this.limits.maxBytes, diskBudget);
      disconnected.throwIfAborted();
      if (!background) return await this.process(staging, upload, disconnected);
      const jobId = randomUUID();
      const job: Job = { controller: new AbortController(), status: { state: 'processing' } };
      this.jobs.set(jobId, job);
      this.pruneJobs();
      this.background = { controller: job.controller, done: this.completeJob(job, staging, upload) };
      handedOff = true;
      return { status: 202 as const, body: { jobId } };
    } finally {
      if (!handedOff) await this.release(staging);
    }
  }
}
