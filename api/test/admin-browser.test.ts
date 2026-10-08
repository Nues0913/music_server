import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { chromium, type Page } from 'playwright-core';
import { registerAdmin } from '../src/modules/admin/routes.js';

const executablePath = process.env.BROWSER_PATH ?? '/usr/bin/chromium';
const options = { skip: !existsSync(executablePath), timeout: 20000 };
const audio = (name: string, size = 16) => ({ name, mimeType: 'audio/wav', buffer: Buffer.alloc(size) });
const ready = (page: Page) => page.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled);
const completed = (page: Page) => page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('批次完成'));
async function browserFixture(app: ReturnType<typeof Fastify>, run: (page: Page) => Promise<void>) {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
  try {
    const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${address}/admin`); await ready(page);
    await run(page); assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); }
}
test('browser loads modular admin assets and recovers after HTTP failure without storing the token', options, async () => {
  const app = Fastify(); registerAdmin(app, 100000, true);
  app.post('/v1/songs', { onRequest: async (_request, reply) => reply.code(401).send({ error: 'fixture auth failure' }) }, async () => ({}));
  await browserFixture(app, async page => {
    await page.locator('#file').setInputFiles([audio('first.wav'), audio('second.wav')]);
    await page.locator('#token').fill('fixture-token-012345678901234567890');
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('批次已停止'));
    assert.match(await page.locator('.entry-status').first().innerText(), /fixture auth failure/);
    assert.equal(await page.locator('.file-entry').nth(1).getAttribute('data-state'), 'pending');
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('#cancel').isHidden(), true);
    assert.equal(await page.locator('#progress').isHidden(), true);
    await page.locator('#clear-token').click(); assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    for (const asset of ['client', 'controller', 'validation', 'view']) {
      const response = await app.inject(`/admin/uploads/${asset}.js`);
      assert.equal(response.statusCode, 200); assert.match(response.headers['content-type'] as string, /javascript/);
    }
    assert.equal((await app.inject('/admin/uploads/unknown.js')).statusCode, 404);
  });
});
test('browser uploads multiple files with individual metadata, mixed results and selective retry on desktop and mobile', options, async () => {
  const app = Fastify(); registerAdmin(app, 100000, true); app.register(multipart);
  const received: { name: string; title: string; artist: string }[] = [];
  let retry = false;
  app.post('/v1/songs', async (request, reply) => {
    const part = await request.file(); assert.ok(part); await part.toBuffer();
    const fields = part.fields as any;
    received.push({ name: part.filename, title: fields.title.value, artist: fields.artist.value });
    if (part.filename === 'failed.wav' && !retry) return reply.code(422).send({ error: 'fixture invalid audio' });
    return reply.code(part.filename === 'duplicate.wav' ? 200 : 201).send({
      status: part.filename === 'duplicate.wav' ? 'duplicate' : 'imported', id: part.filename,
      song: { title: fields.title.value || part.filename, artist: fields.artist.value },
    });
  });
  await browserFixture(app, async page => {
    const hostileName = '<img src=x onerror=alert(1)>.wav';
    await page.locator('#file').setInputFiles([audio(hostileName), audio('duplicate.wav'), audio('failed.wav'), audio('last.wav'), audio('invalid.exe'), audio('oversize.wav', 100001)]);
    assert.equal(await page.locator('.file-entry').count(), 6);
    assert.equal(await page.locator('#file').inputValue(), '');
    await page.locator('#title').fill(' <script>alert(1)</script> ');
    await page.locator('.file-entry').nth(2).locator('input[data-field=artist]').fill(' singer ');
    await page.locator('#token').fill('fixture-token-012345678901234567890');
    await page.locator('#submit').click(); await completed(page); await ready(page);
    assert.deepEqual(received.map(item => item.name), [hostileName, 'duplicate.wav', 'failed.wav', 'last.wav']);
    assert.equal(received[0].title, '<script>alert(1)</script>'); assert.equal(received[2].artist, 'singer');
    assert.deepEqual(await page.locator('.file-entry').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.state)),
      ['imported', 'duplicate', 'failed', 'imported', 'invalid', 'invalid']);
    assert.match(await page.locator('.entry-result').first().innerText(), /<script>alert\(1\)<\/script>/);
    assert.equal(await page.locator('#file-list img, #file-list script').count(), 0);
    assert.match(await page.locator('#status').innerText(), /2 首已加入曲庫.*1 首曲庫已有.*3 首失敗/);
    retry = true; await page.locator('#submit').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-state=imported]').length === 3); await ready(page);
    assert.deepEqual(received.map(item => item.name), [hostileName, 'duplicate.wav', 'failed.wav', 'last.wav', 'failed.wav']);
    assert.equal(await page.locator('#title').isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/music-server-batch-mobile.png', fullPage: true });
    await page.locator('#file').setInputFiles(audio('replacement.wav'));
    assert.equal(await page.locator('.file-entry').count(), 1);
    await page.locator('button[data-remove]').click(); await page.locator('#submit').click();
    assert.equal(await page.locator('.file-entry').count(), 0); assert.equal(received.length, 5);
  });
});
test('browser accepts a multi-file drop and cancellation stops the queue; retry retains completed results', options, async () => {
  const app = Fastify(); registerAdmin(app, 100000, true); app.register(multipart);
  const received: string[] = [];
  let release!: () => void;
  app.post('/v1/songs', async request => {
    const part = await request.file(); assert.ok(part); await part.toBuffer(); received.push(part.filename);
    if (received.length === 2) await new Promise<void>(resolve => { release = resolve; });
    return { status: received.length === 3 ? 'duplicate' : 'imported', id: part.filename, song: { title: part.filename } };
  });
  await browserFixture(app, async page => {
    await page.locator('#drop-zone').evaluate(zone => {
      const transfer = new DataTransfer();
      for (const name of ['first.wav', 'second.wav', 'third.wav']) transfer.items.add(new File(['fixture'], name, { type: 'audio/wav' }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    assert.equal(await page.locator('.file-entry').count(), 3);
    await page.locator('#token').fill('fixture-token-012345678901234567890'); await page.locator('#submit').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-state=imported]').length === 1
      && document.querySelector('[data-state=uploading] progress')?.getAttribute('value') === '100');
    assert.equal(await page.locator('#file').isDisabled(), true);
    assert.equal(await page.locator('button[data-remove]').first().isDisabled(), true);
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('已取消批次'));
    release(); await ready(page);
    assert.deepEqual(received, ['first.wav', 'second.wav']);
    assert.deepEqual(await page.locator('.file-entry').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.state)), ['imported', 'cancelled', 'pending']);
    await page.locator('#submit').click(); await completed(page); await ready(page);
    assert.deepEqual(received, ['first.wav', 'second.wav', 'second.wav', 'third.wav']);
    assert.equal(await page.locator('[data-state=duplicate]').count(), 1);
  });
});
