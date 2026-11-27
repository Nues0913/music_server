import { statfs } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { CapacityError } from './errors.js';

export interface CapacityLimits { maxBytes: number; minFreeBytes: number; quotaBytes: number; }
export async function assertDiskCapacity(root: string, size: number, minFreeBytes: number) {
  const space = await statfs(root);
  if (space.bavail * space.bsize - size < minFreeBytes) throw new CapacityError('Insufficient free disk space');
}
export async function assertLibraryQuota(db: PrismaClient, size: number, quotaBytes: number) {
  const total = await db.song.aggregate({ _sum: { byteSize: true } });
  if ((total._sum.byteSize ?? 0) + size > quotaBytes) throw new CapacityError('Library quota exceeded');
}

export async function uploadDiskBudget(root: string, minFreeBytes: number) {
  // Reserve space for staging and an output file. The encoder checks the actual output budget separately.
  return Math.floor(await availableDiskBudget(root, minFreeBytes) / 2);
}

export async function availableDiskBudget(root: string, minFreeBytes: number) {
  const space = await statfs(root);
  return space.bavail * space.bsize - minFreeBytes;
}
