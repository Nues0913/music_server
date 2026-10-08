import { statfs } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';

export interface CapacityLimits { maxBytes: number; minFreeBytes: number; quotaBytes: number; }
export async function assertImportCapacity(db: PrismaClient, root: string, size: number, limits: CapacityLimits) {
  const space = await statfs(root);
  if (space.bavail * space.bsize - size < limits.minFreeBytes) throw new Error('Insufficient free disk space');
  const total = await db.song.aggregate({ _sum: { byteSize: true } });
  if ((total._sum.byteSize ?? 0) + size > limits.quotaBytes) throw new Error('Library quota exceeded');
}

export async function uploadDiskBudget(root: string, minFreeBytes: number) {
  const space = await statfs(root);
  // An upload needs both its staging file and the subsequent import copy.
  return Math.floor((space.bavail * space.bsize - minFreeBytes) / 2);
}
