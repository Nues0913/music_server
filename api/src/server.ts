import { buildApp } from './app.js';
import { apiToken, adminToken, audioDirectory, positiveInteger } from './config.js';
import { connectDatabase } from './db.js';

const token = apiToken();
const db = await connectDatabase();
const admin = adminToken();
const app = buildApp({ db, token, audioRoot: audioDirectory(), logging: true,
  upload: admin ? {
    adminToken: admin,
    maxBytes: Math.min(positiveInteger('MAX_AUDIO_BYTES', 256 * 1024 * 1024), 256 * 1024 * 1024),
    minFreeBytes: positiveInteger('MIN_FREE_BYTES', 512 * 1024 * 1024),
    quotaBytes: positiveInteger('LIBRARY_QUOTA_BYTES', 10 * 1024 * 1024 * 1024),
  } : undefined,
});
app.addHook('onClose', async () => { await db.$disconnect(); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
try {
  await app.listen({ port: 3000, host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
