import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import { chromium } from 'playwright-core';
import { registerAdmin } from '../src/modules/admin/routes.js';

const executablePath = process.env.BROWSER_PATH ?? '/usr/bin/chromium';
test('browser loads modular admin assets and recovers after HTTP failure without storing the token', {
  skip: !existsSync(executablePath), timeout: 20000,
}, async () => {
  const app = Fastify();
  registerAdmin(app, 100000, true);
  // HTTP fixture isolates the UI contract; SQLite persistence has separate integration tests.
  app.post('/v1/songs', { onRequest: async (_request, reply) => reply.code(401).send({ error: 'fixture auth failure' }) },
    async () => ({}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${address}/admin`);
    await page.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled);
    await page.locator('#file').setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: Buffer.from('fixture audio') });
    await page.locator('#token').fill('fixture-token-012345678901234567890');
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'fixture auth failure');
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('#cancel').isHidden(), true);
    assert.equal(await page.locator('#progress').isHidden(), true);
    await page.locator('#clear-token').click(); assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []);
    for (const asset of ['client', 'controller', 'validation', 'view']) {
      const response = await app.inject(`/admin/uploads/${asset}.js`);
      assert.equal(response.statusCode, 200); assert.match(response.headers['content-type'] as string, /javascript/);
    }
    assert.equal((await app.inject('/admin/uploads/unknown.js')).statusCode, 404);
  } finally { await browser?.close(); await app.close(); }
});
