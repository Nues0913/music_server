import { buildApp } from './app.js';
import { apiToken, adminToken, audioDirectory, positiveInteger } from './config.js';
import { connectDatabase } from './infrastructure/database.js';
import { registerShutdown } from './infrastructure/shutdown.js';

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
const stop = registerShutdown(app, db);
try {
  await app.listen({ port: 3000, host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
  app.log.error(error);
  await stop();
  process.exitCode = 1;
}
