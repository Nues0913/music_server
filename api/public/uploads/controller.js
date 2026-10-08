import { fileError } from './validation.js';

export function createUploadController(view, client) {
  let maxBytes = 0, enabled = false, active, disposed = false, requestId = 0;
  function chooseFile() {
    const file = view.values().file;
    if (!file) return;
    view.selected(file);
    const error = fileError(file, maxBytes);
    view.message(error || '音檔已選擇，可以填寫資訊並上傳。', error ? 'error' : '');
  }
  async function submit() {
    if (active || !enabled || disposed) return;
    const values = view.values();
    const error = fileError(values.file, maxBytes);
    if (error) return view.message('請選擇符合格式與大小限制的音檔。', 'error');
    const currentRequest = ++requestId;
    view.busy(true, enabled); view.progress(0); view.clearResult(); view.message('正在上傳…');
    try {
      active = client.upload({ ...values, onProgress(percent) {
        if (disposed || currentRequest !== requestId) return;
        view.progress(percent);
        view.message(percent === 100 ? '傳送完成，正在驗證並加入曲庫…' : `正在上傳 ${percent}%`);
      } });
      const result = await active.done;
      if (disposed) return;
      const duplicate = result.status === 'duplicate';
      view.message(duplicate ? '曲庫已有相同音檔，未重複新增。' : '歌曲已加入曲庫！', 'success');
      view.result(result);
      if (!duplicate) view.resetFile();
    } catch (failure) {
      if (!disposed) view.message(failure.message, failure.cancelled ? '' : 'error');
    } finally {
      requestId++;
      active = undefined;
      if (!disposed) { view.busy(false, enabled); view.hideProgress(); }
    }
  }
  async function initialize() {
    try {
      const config = await client.config();
      if (disposed) return;
      maxBytes = config.maxBytes; enabled = config.enabled;
      view.configure(maxBytes, enabled); view.busy(false, enabled);
    } catch {
      if (!disposed) { view.configFailed(); view.message('無法讀取服務設定，請重新整理頁面。', 'error'); }
    }
  }
  return { initialize, chooseFile, submit, cancel: () => active?.abort(), isBusy: () => Boolean(active),
    dispose() { disposed = true; requestId++; active?.abort(); } };
}
