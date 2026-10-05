import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

export function registerAdmin(app: FastifyInstance, maxBytes: number, enabled: boolean) {
  const files = [
    ['/admin', 'index.html', 'text/html; charset=utf-8'],
    ['/admin/app.js', 'app.js', 'application/javascript; charset=utf-8'],
    ['/admin/style.css', 'style.css', 'text/css; charset=utf-8'],
  ];
  app.get('/', async (_request, reply) => reply.redirect('/admin'));
  app.get('/admin/', async (_request, reply) => reply.redirect('/admin'));
  for (const [url, file, type] of files) {
    app.get(url!, async (_request, reply) => {
      return reply.type(type!).header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        .send(await readFile(new URL(`../public/${file}`, import.meta.url)));
    });
  }
  app.get('/admin/config', async () => ({ maxBytes, enabled }));
}
