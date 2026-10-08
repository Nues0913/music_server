import { fileError } from './validation.js';

export function createUploadController(view, client) {
  let maxBytes = 0, enabled = false, active, disposed = false, requestId = 0;
  let entries = [], nextId = 0, running = false, cancelled = false;
  const finished = entry => entry.state === 'imported' || entry.state === 'duplicate';
  function renderSelection() {
    view.selected(entries); view.renderEntries(entries); view.busy(false, enabled);
  }
  function chooseFile() {
    if (running || disposed) return;
    const files = view.values().files;
    if (!files.length) return;
    entries = files.map(file => {
      const error = maxBytes ? fileError(file, maxBytes) : undefined;
      return { id: String(++nextId), file, name: file.name, size: file.size, title: '', artist: '',
        state: error ? 'invalid' : 'pending', error, progress: 0 };
    });
    // The queue owns File references; clearing the picker allows selecting the same files again.
    view.clearFileInput(); renderSelection(); view.clearResult();
    view.message(`已選擇 ${entries.length} 首歌曲，請確認各首資訊後上傳。`);
  }
  function editEntry(id, field, value) {
    if (running || disposed || !['title', 'artist'].includes(field)) return;
    const entry = entries.find(item => item.id === id);
    if (entry && !finished(entry)) entry[field] = value;
  }
  function removeEntry(id) {
    if (running || disposed) return;
    entries = entries.filter(entry => entry.id !== id);
    renderSelection(); view.clearResult();
    view.message(entries.length ? `清單剩餘 ${entries.length} 首歌曲。` : '請選擇歌曲。');
  }
  async function submit() {
    if (running || !enabled || disposed) return;
    const jobs = entries.filter(entry => !finished(entry) && entry.state !== 'invalid');
    if (!jobs.length) return view.message('請選擇符合格式與大小限制、尚未完成的音檔。', 'error');
    const token = view.values().token;
    running = true; cancelled = false;
    let stoppedByFailure = false;
    view.busy(true, enabled); view.progress(0); view.clearResult();
    try {
      for (const [index, entry] of jobs.entries()) {
        if (cancelled || disposed) break;
        const currentRequest = ++requestId;
        entry.state = 'uploading'; entry.progress = 0; entry.error = undefined;
        view.entry(entry); view.message(`正在上傳 ${index + 1}/${jobs.length}：${entry.name}`);
        try {
          active = client.upload({ file: entry.file, title: entry.title, artist: entry.artist, token,
            onProgress(percent) {
              if (disposed || currentRequest !== requestId || entry.state !== 'uploading') return;
              entry.progress = percent; view.entry(entry);
              view.progress(Math.round((index + percent / 100) / jobs.length * 100));
              view.message(percent === 100 ? `傳送完成，正在驗證 ${index + 1}/${jobs.length}：${entry.name}`
                : `正在上傳 ${index + 1}/${jobs.length}：${entry.name}（${percent}%）`);
            },
          });
          const result = await active.done;
          if (disposed) break;
          entry.state = result.status === 'duplicate' ? 'duplicate' : 'imported';
          entry.progress = 100; entry.result = result; entry.file = undefined;
        } catch (failure) {
          if (disposed) break;
          entry.state = failure.cancelled ? 'cancelled' : 'failed'; entry.error = failure.message;
          if (failure.cancelled) cancelled = true;
          // A bad credential or exhausted storage affects every remaining file.
          if ([401, 403, 507].includes(failure.status)) { cancelled = true; stoppedByFailure = true; }
        } finally { requestId++; active = undefined; }
        if (!disposed) { view.entry(entry); view.progress(Math.round((index + 1) / jobs.length * 100)); }
      }
      if (disposed) return;
      const count = state => entries.filter(entry => entry.state === state).length;
      const failed = count('failed') + count('invalid'), pending = count('pending') + count('cancelled');
      const prefix = stoppedByFailure ? '批次已停止' : cancelled ? '已取消批次' : '批次完成';
      view.message(`${prefix}：${count('imported')} 首已加入曲庫，${count('duplicate')} 首曲庫已有相同音檔，${failed} 首失敗，${pending} 首未完成。`,
        failed ? 'error' : cancelled ? '' : 'success');
    } finally {
      requestId++; active = undefined; running = false;
      if (!disposed) { view.busy(false, enabled); view.hideProgress(); }
    }
  }
  async function initialize() {
    try {
      const config = await client.config();
      if (disposed) return;
      maxBytes = config.maxBytes; enabled = config.enabled;
      for (const entry of entries) {
        entry.error = fileError(entry.file, maxBytes); entry.state = entry.error ? 'invalid' : 'pending';
      }
      view.configure(maxBytes, enabled); renderSelection();
    } catch {
      if (!disposed) { view.configFailed(); view.message('無法讀取服務設定，請重新整理後再試。', 'error'); }
    }
  }
  return { initialize, chooseFile, editEntry, removeEntry, submit,
    cancel() { if (running) { cancelled = true; requestId++; active?.abort(); } },
    isBusy: () => running,
    dispose() { disposed = true; cancelled = true; requestId++; active?.abort(); },
  };
}
