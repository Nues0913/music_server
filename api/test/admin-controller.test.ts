import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadController } from '../public/uploads/controller.js';
import { createUploadClient } from '../public/uploads/client.js';

function fixture(upload: (values: unknown) => unknown) {
  const calls: [string, ...unknown[]][] = [];
  const values = { file: { name: 'song.wav', size: 100 }, title: '', artist: '', token: 'private-page-token' };
  const view = Object.fromEntries(['message', 'selected', 'busy', 'progress', 'clearResult', 'result', 'resetFile', 'hideProgress', 'configure', 'configFailed']
    .map(name => [name, (...args: unknown[]) => calls.push([name, ...args])])) as any;
  view.values = () => values;
  const controller = createUploadController(view, { config: async () => ({ maxBytes: 1000, enabled: true }), upload });
  return { controller, calls, values };
}
test('failed upload releases loading and can be submitted again without clearing the selected file', async () => {
  let attempts = 0;
  const { controller, calls } = fixture(() => { attempts++; return { done: Promise.reject(new Error('network failed')), abort() {} }; });
  await controller.initialize(); await controller.submit(); await controller.submit();
  assert.equal(attempts, 2); assert.equal(controller.isBusy(), false);
  assert.ok(calls.some(call => call[0] === 'message' && call[1] === 'network failed' && call[2] === 'error'));
  assert.ok(!calls.some(call => call[0] === 'resetFile'));
  assert.deepEqual(calls.at(-2), ['busy', false, true]);
});
test('one upload owns the page state; cancellation frees it and is not shown as server failure', async () => {
  let reject!: (failure: Error) => void, uploads = 0;
  const { controller, calls } = fixture(() => {
    uploads++;
    return { done: new Promise((_, fail) => { reject = fail; }), abort: () => reject(Object.assign(new Error('cancelled'), { cancelled: true })) };
  });
  await controller.initialize(); const pending = controller.submit(); await controller.submit();
  assert.equal(uploads, 1); controller.cancel(); await pending;
  assert.equal(controller.isBusy(), false);
  assert.ok(calls.some(call => call[0] === 'message' && call[1] === 'cancelled' && call[2] === ''));
});
test('disposed page aborts its transport and ignores late progress and results', async () => {
  let complete!: (result: object) => void, progress!: (percent: number) => void, aborted = false;
  const { controller, calls } = fixture((values: any) => {
    progress = values.onProgress;
    return { done: new Promise(resolve => { complete = resolve; }), abort() { aborted = true; } };
  });
  await controller.initialize(); const pending = controller.submit(); controller.dispose();
  const count = calls.length; progress(100); complete({ status: 'imported', song: { title: 'late' } }); await pending;
  assert.ok(aborted); assert.equal(calls.length, count);
});
test('invalid file never reaches transport; duplicate success preserves the selected form', async () => {
  let uploads = 0;
  const { controller, calls, values } = fixture(() => {
    uploads++; return { done: Promise.resolve({ status: 'duplicate', id: 'song', song: { title: 'existing' } }), abort() {} };
  });
  await controller.initialize(); values.file.name = 'file.exe'; await controller.submit(); assert.equal(uploads, 0);
  values.file.name = 'song.wav'; await controller.submit(); assert.equal(uploads, 1);
  assert.ok(calls.some(call => call[0] === 'message' && call[2] === 'success'));
  assert.ok(!calls.some(call => call[0] === 'resetFile'));
});
test('upload transport trims metadata, bounds progress and rejects malformed responses', async () => {
  let xhr: any, fields: [string, unknown][] = [], percentages: number[] = [];
  class FakeXHR {
    upload = {}; status = 200; responseText = 'not-json'; headers: Record<string, string> = {};
    constructor() { xhr = this; }
    open(method: string, path: string) { assert.equal(method, 'POST'); assert.equal(path, '/v1/songs'); }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    send() {} abort() { (this as any).onabort(); }
  }
  class FakeFormData { append(key: string, value: unknown) { fields.push([key, value]); } }
  const client = createUploadClient({ XMLHttpRequest: FakeXHR, FormData: FakeFormData });
  const request = client.upload({ file: {}, title: ' title ', artist: ' artist ', token: ' token ', onProgress: (n: number) => percentages.push(n) });
  const rejected = assert.rejects(request.done, /伺服器回應異常/);
  xhr.upload.onprogress({ lengthComputable: true, loaded: 110, total: 100 }); xhr.onload(); await rejected;
  assert.equal(xhr.headers.Authorization, 'Bearer token'); assert.deepEqual(fields.slice(0, 2), [['title', 'title'], ['artist', 'artist']]);
  assert.deepEqual(percentages, [100]);
});

test('completed upload ignores late progress that could overwrite the next operation status', async () => {
  let progress!: (percent: number) => void;
  const { controller, calls } = fixture((values: any) => {
    progress = values.onProgress;
    return { done: Promise.resolve({ status: 'imported', id: 'id', song: { title: 'done' } }), abort() {} };
  });
  await controller.initialize(); await controller.submit();
  const count = calls.length; progress(50);
  assert.equal(calls.length, count);
});
