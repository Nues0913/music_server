import 'dotenv/config';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/admin`);
  await page.waitForFunction(() => !document.getElementById('submit').disabled);
  const data = await readFile('../data/inbox/smoke-test-中文.wav');
  data.writeInt16LE(713, 44);
  await page.locator('#file').setInputFiles({ name: 'browser-test-中文.wav', mimeType: 'audio/wav', buffer: data });
  await page.locator('#title').fill('網頁上傳驗證');
  await page.locator('#artist').fill('測試演出者');
  // A playback token must not be allowed to upload.
  await page.locator('#token').fill(process.env.API_TOKEN);
  const forbidden = page.waitForResponse(response => response.url().endsWith('/v1/songs') && response.request().method() === 'POST');
  await page.locator('#submit').click();
  assert.equal((await forbidden).status(), 401);
  await page.waitForFunction(() => !document.getElementById('submit').disabled);
  await page.locator('#token').fill(process.env.ADMIN_TOKEN);
  const uploaded = page.waitForResponse(response => response.url().endsWith('/v1/songs') && response.request().method() === 'POST');
  await page.locator('#submit').click();
  const response = await uploaded;
  assert.ok([200, 201].includes(response.status()), await response.text());
  const result = await response.json();
  assert.equal(result.song.title, '網頁上傳驗證');
  assert.equal(result.song.artist, '測試演出者');
  await page.waitForFunction(() => !document.getElementById('submit').disabled);
  assert.match(await page.locator('#status').innerText(), /已加入曲庫|已有相同音檔/);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.locator('#clear-token').click();
  assert.equal(await page.locator('#token').inputValue(), '');
  await mkdir('../data/verification', { recursive: true });
  await page.screenshot({ path: '../data/verification/upload-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '../data/verification/upload-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: browser upload, admin authorization, title/artist, token clearing, no localStorage, desktop/mobile layout (${result.status})`);
} finally {
  await browser.close();
}
