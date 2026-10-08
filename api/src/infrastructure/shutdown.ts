import type { EventEmitter } from 'node:events';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

/** Fastify drains active requests before onClose disconnects their database. */
export function registerShutdown(app: FastifyInstance, db: Pick<PrismaClient, '$disconnect'>, signals: EventEmitter = process) {
  let closing: Promise<void> | undefined;
  const stop = () => closing ??= app.close();
  const onSignal = () => {
    void stop().catch(error => { app.log.error(error); process.exitCode = 1; });
  };
  app.addHook('onClose', async () => {
    try { await db.$disconnect(); }
    finally {
      signals.off('SIGTERM', onSignal);
      signals.off('SIGINT', onSignal);
    }
  });
  signals.once('SIGTERM', onSignal);
  signals.once('SIGINT', onSignal);
  return stop;
}
