import { PrismaClient } from '@prisma/client';

export async function connectDatabase(url = process.env.DATABASE_URL): Promise<PrismaClient> {
  if (!url?.startsWith('file:')) throw new Error('DATABASE_URL must be a SQLite file URL');
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    await db.$connect();
    await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await db.$queryRawUnsafe('PRAGMA busy_timeout=5000');
    await db.$queryRawUnsafe('PRAGMA cache_size=-4096');
    await db.$queryRawUnsafe('PRAGMA mmap_size=0');
    return db;
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
}
