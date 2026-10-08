import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadController } from '../public/uploads/controller.js';
import { createUploadClient } from '../public/uploads/client.js';

const song = (status = 'imported') => ({ status, id: 'song-id', song: { title: 'song' } });
function fixture(upload: (values: any) => any, config = async () => ({ maxBytes: 1000, enabled: true })) {
  const calls: [string, ...unknown[]][] = [];
  const values = { files: [{ name: 'song.wav', size: 100 }], token: 'private-page-token' };
  let entries: any[] = [];
  const view = Object.fromEntries(['message', 'selected', 'busy', 'progress', 'clearResult', 'hideProgress', 'configure', 'configFailed', 'clearFileInput']
    .map(name => [name, (...args: unknown[]) => calls.push([name, ...args])])) as any;
  view.values = () => values;
  view.renderEntries = (items: any[]) => { entries = items; };
  view.entry = (entry: any) => calls.push(['entry', { ...entry }]);
  const controller = createUploadController(view, { config, upload });
  const select = (names: string[]) => { values.files = names.map(name => ({ name, size: 100 })); controller.chooseFile(); };
  return { controller, calls, values, select, entries: () => entries };
}
test('batch uploads serially, forwards individual metadata, skips invalid files and retries only unfinished files', async () => {
  const names: string[] = [], requests: any[] = [];
  let rejectThird = true, concurrent = 0, peak = 0;
  const f = fixture(values => {
    names.push(values.file.name); requests.push(values); concurrent++; peak = Math.max(peak, concurrent);
    return { done: Promise.resolve().then(() => {
      concurrent--;
      if (values.file.name === 'failed.wav' && rejectThird) throw new Error('network failed');
      return song(values.file.name === 'duplicate.wav' ? 'duplicate' : 'imported');
    }), abort() {} };
  });
  await f.controller.initialize(); f.select(['first.wav', 'duplicate.wav', 'failed.wav', 'file.exe', 'last.wav']);
  f.controller.editEntry(f.entries()[0].id, 'title', 'First title');
  f.controller.editEntry(f.entries()[2].id, 'artist', 'Third artist');
  const pending = f.controller.submit(); await f.controller.submit(); await pending;
  assert.equal(peak, 1); assert.deepEqual(names, ['first.wav', 'duplicate.wav', 'failed.wav', 'last.wav']);
  assert.equal(requests[0].title, 'First title'); assert.equal(requests[2].artist, 'Third artist');
  assert.deepEqual(f.entries().map(entry => entry.state), ['imported', 'duplicate', 'failed', 'invalid', 'imported']);
  assert.equal(f.entries()[0].file, undefined); assert.equal(f.entries()[1].file, undefined);
  assert.equal(f.entries()[2].file.name, 'failed.wav');
  assert.ok(f.calls.some(call => call[0] === 'message' && /2 首已加入曲庫.*1 首曲庫已有.*2 首失敗/.test(String(call[1]))));
  rejectThird = false; await f.controller.submit();
  assert.deepEqual(names, ['first.wav', 'duplicate.wav', 'failed.wav', 'last.wav', 'failed.wav']);
  assert.equal(f.entries()[2].state, 'imported'); assert.equal(f.controller.isBusy(), false);
  assert.deepEqual(f.calls.at(-2), ['busy', false, true]);
});
test('cancellation aborts the current file, preserves completed files and stops remaining requests until retry', async () => {
  let reject!: (failure: Error) => void, progress!: (percent: number) => void;
  const names: string[] = [];
  const f = fixture(values => {
    names.push(values.file.name);
    if (names.length !== 2) return { done: Promise.resolve(song()), abort() {} };
    progress = values.onProgress;
    return { done: new Promise((_, fail) => { reject = fail; }), abort: () => reject(Object.assign(new Error('cancelled'), { cancelled: true })) };
  });
  await f.controller.initialize(); f.select(['first.wav', 'second.wav', 'third.wav']);
  const pending = f.controller.submit(); await new Promise(resolve => setImmediate(resolve));
  f.controller.cancel(); const count = f.calls.length; progress(90); assert.equal(f.calls.length, count); await pending;
  assert.deepEqual(names, ['first.wav', 'second.wav']);
  assert.deepEqual(f.entries().map(entry => entry.state), ['imported', 'cancelled', 'pending']);
  assert.ok(f.calls.some(call => call[0] === 'message' && String(call[1]).startsWith('已取消批次') && call[2] === ''));
  await f.controller.submit(); assert.deepEqual(names, ['first.wav', 'second.wav', 'second.wav', 'third.wav']);
});
test('disposed page aborts its transport and ignores late progress and results without starting the next file', async () => {
  let complete!: (result: object) => void, progress!: (percent: number) => void, aborted = false, uploads = 0;
  const f = fixture(values => {
    uploads++; progress = values.onProgress;
    return { done: new Promise(resolve => { complete = resolve; }), abort() { aborted = true; } };
  });
  await f.controller.initialize(); f.select(['first.wav', 'second.wav']);
  const pending = f.controller.submit(); f.controller.dispose();
  const count = f.calls.length; progress(100); complete(song()); await pending;
  assert.ok(aborted); assert.equal(f.calls.length, count); assert.equal(uploads, 1);
});
test('authentication and storage failures stop the batch, leaving remaining files available for retry', async () => {
  for (const status of [401, 403, 507]) {
    let uploads = 0;
    const f = fixture(() => { uploads++; return { done: Promise.reject(Object.assign(new Error('global failure'), { status })), abort() {} }; });
    await f.controller.initialize(); f.select(['first.wav', 'second.wav']); await f.controller.submit();
    assert.equal(uploads, 1); assert.deepEqual(f.entries().map(entry => entry.state), ['failed', 'pending']);
    assert.ok(f.calls.some(call => call[0] === 'message' && String(call[1]).startsWith('批次已停止') && call[2] === 'error'));
  }
});
test('selection made before config is validated when file limits arrive; removing all files never resurrects them', async () => {
  let configure!: (config: { maxBytes: number; enabled: boolean }) => void, uploads = 0;
  const f = fixture(() => { uploads++; return { done: Promise.resolve(song()), abort() {} }; }, () => new Promise(resolve => { configure = resolve; }));
  const ready = f.controller.initialize(); f.select(['first.wav', 'second.exe']);
  configure({ maxBytes: 50, enabled: true }); await ready;
  assert.deepEqual(f.entries().map(entry => entry.state), ['invalid', 'invalid']);
  for (const entry of [...f.entries()]) f.controller.removeEntry(entry.id);
  await f.controller.submit(); assert.equal(uploads, 0); assert.equal(f.entries().length, 0);
});
test('an old file progress event cannot overwrite the next file status or final summary', async () => {
  const progress: ((percent: number) => void)[] = [];
  let complete!: (result: object) => void;
  const f = fixture(values => {
    progress.push(values.onProgress);
    return { done: progress.length === 1 ? Promise.resolve(song()) : new Promise(resolve => { complete = resolve; }), abort() {} };
  });
  await f.controller.initialize(); f.select(['first.wav', 'second.wav']);
  const pending = f.controller.submit(); await new Promise(resolve => setImmediate(resolve));
  const count = f.calls.length; progress[0](90); assert.equal(f.calls.length, count);
  progress[1](50); assert.equal(f.entries()[1].progress, 50);
  complete(song()); await pending;
  const finalCount = f.calls.length; progress[1](80); assert.equal(f.calls.length, finalCount);
});
test('upload transport trims metadata, bounds progress and exposes HTTP failures including malformed error bodies', async () => {
  let xhr: any; const fields: [string, unknown][] = [], percentages: number[] = [];
  class FakeXHR {
    upload = {}; status = 401; responseText = 'not-json'; headers: Record<string, string> = {};
    constructor() { xhr = this; }
    open(method: string, path: string) { assert.equal(method, 'POST'); assert.equal(path, '/v1/songs'); }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    send() {} abort() { (this as any).onabort(); }
  }
  class FakeFormData { append(key: string, value: unknown) { fields.push([key, value]); } }
  const client = createUploadClient({ XMLHttpRequest: FakeXHR, FormData: FakeFormData });
  const request = client.upload({ file: {}, title: ' title ', artist: ' artist ', token: ' token ', onProgress: (n: number) => percentages.push(n) });
  const rejected = assert.rejects(request.done, (error: any) => error.status === 401 && /伺服器回應異常/.test(error.message));
  xhr.upload.onprogress({ lengthComputable: true, loaded: 110, total: 100 }); xhr.onload(); await rejected;
  assert.equal(xhr.headers.Authorization, 'Bearer token'); assert.deepEqual(fields.slice(0, 2), [['title', 'title'], ['artist', 'artist']]);
  assert.deepEqual(percentages, [100]);
  const jsonFailure = client.upload({ file: {}, title: '', artist: '', token: '', onProgress() {} });
  const jsonRejected = assert.rejects(jsonFailure.done, (error: any) => error.status === 403 && error.message === 'denied');
  xhr.status = 403; xhr.responseText = '{"error":"denied"}'; xhr.onload(); await jsonRejected;
});
