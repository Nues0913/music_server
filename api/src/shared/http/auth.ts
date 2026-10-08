import { createHash, timingSafeEqual } from 'node:crypto';
import type { onRequestHookHandler } from 'fastify';

export function bearerAuth(token: string, message = 'Unauthorized', challenge = true): onRequestHookHandler {
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return async (request, reply) => {
    const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expected, actual)) {
      if (challenge) reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send({ error: message });
    }
    reply.header('Cache-Control', 'no-store');
  };
}
