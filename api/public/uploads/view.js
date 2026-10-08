export function createUploadView(document) {
  const byId = id => document.getElementById(id);
  const input = byId('file'), status = byId('status'), progress = byId('progress'), list = byId('file-list');
  const rows = new Map();
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function updateEntry(entry) {
    const row = rows.get(entry.id);
    if (!row) return;
    row.root.dataset.state = entry.state;
    const labels = { pending: '等待上傳', invalid: '無法上傳', uploading: entry.progress === 100 ? '正在驗證並加入曲庫…' : `正在上傳 ${entry.progress}%`,
      imported: '已加入曲庫', duplicate: '曲庫已有相同音檔', failed: '上傳失敗', cancelled: '已取消' };
    row.status.textContent = `${labels[entry.state]}${entry.error ? '：' + entry.error : ''}`;
    row.progress.hidden = entry.state !== 'uploading'; row.progress.value = entry.progress;
    const result = entry.result;
    row.result.textContent = result ? `${result.song.title}${result.song.artist ? ' — ' + result.song.artist : ''} · ID：${result.id}${result.song.status === 'disabled' ? '（目前已停用）' : ''}` : '';
  }
  return {
    values: () => ({ files: Array.from(input.files), token: byId('token').value }),
    message(text, state = '') { status.textContent = text; status.parentElement.className = `result ${state}`; },
    selected(entries) {
      byId('file-label').textContent = entries.length ? `已選擇 ${entries.length} 首歌曲` : '拖曳多首音檔到這裡，或點選檔案';
      byId('file-detail').textContent = entries.length ? `共 ${(entries.reduce((total, entry) => total + entry.size, 0) / 1024 / 1024).toFixed(2)} MiB`
        : 'MP3、FLAC、WAV、OGG、Opus、M4A、WebM';
    },
    renderEntries(entries) {
      rows.clear(); list.replaceChildren();
      for (const [index, entry] of entries.entries()) {
        const root = element('li', 'file-entry'), heading = element('div', 'entry-heading');
        const remove = element('button', 'text-button', '移除');
        remove.type = 'button'; remove.dataset.remove = entry.id; remove.setAttribute('aria-label', `移除 ${entry.name}`);
        heading.append(element('strong', '', entry.name), remove);
        root.append(heading, element('p', 'hint', `${(entry.size / 1024 / 1024).toFixed(2)} MiB`));
        const fields = element('div', 'fields');
        for (const [field, labelText, placeholder] of [['title', '歌名', '留空則使用音檔標籤或檔名'], ['artist', '演出者', '留空則使用音檔標籤']]) {
          const label = element('label', '', `${labelText} `), control = element('input');
          label.append(element('span', 'optional', '選填'));
          control.id = index === 0 ? field : `${field}-${entry.id}`;
          control.maxLength = 500; control.placeholder = placeholder; control.value = entry[field];
          control.dataset.entry = entry.id; control.dataset.field = field;
          label.append(control); fields.append(label);
        }
        const state = element('p', 'entry-status'), bar = element('progress'), result = element('p', 'hint entry-result');
        state.setAttribute('role', 'status'); bar.max = 100; bar.setAttribute('aria-label', `${entry.name} 上傳進度`);
        root.append(fields, state, bar, result); list.append(root);
        rows.set(entry.id, { root, status: state, progress: bar, result }); updateEntry(entry);
      }
    },
    entry: updateEntry,
    busy(busy, enabled) {
      for (const id of ['file', 'token', 'clear-token']) byId(id).disabled = busy;
      for (const row of rows.values()) {
        for (const control of row.root.querySelectorAll('input')) control.disabled = busy || ['imported', 'duplicate'].includes(row.root.dataset.state);
        row.root.querySelector('button').disabled = busy;
      }
      byId('submit').disabled = busy || !enabled; byId('cancel').hidden = !busy;
    },
    progress(value) { progress.hidden = false; progress.value = value; },
    hideProgress() { progress.hidden = true; },
    clearResult() { byId('song-result').textContent = ''; },
    clearFileInput() { input.value = ''; },
    configure(maxBytes, enabled) { byId('limit').textContent = enabled ? `每首音檔上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB` : '此服務未開啟網頁上傳。'; },
    configFailed() { byId('limit').textContent = '無法讀取上傳限制。'; },
  };
}

export function bindUploadEvents(document, controller) {
  const byId = id => document.getElementById(id), zone = byId('drop-zone');
  const cleanups = [];
  function on(element, event, handler) { element.addEventListener(event, handler); cleanups.push(() => element.removeEventListener(event, handler)); }
  on(byId('file'), 'change', controller.chooseFile);
  on(byId('file-list'), 'input', event => {
    if (event.target.dataset.field) controller.editEntry(event.target.dataset.entry, event.target.dataset.field, event.target.value);
  });
  on(byId('file-list'), 'click', event => {
    const button = event.target.closest('button[data-remove]');
    if (button) controller.removeEntry(button.dataset.remove);
  });
  on(byId('clear-token'), 'click', () => { byId('token').value = ''; byId('token').focus(); });
  on(byId('cancel'), 'click', controller.cancel);
  on(byId('upload-form'), 'submit', event => { event.preventDefault(); void controller.submit(); });
  for (const event of ['dragenter', 'dragover']) on(zone, event, e => { e.preventDefault(); if (!controller.isBusy()) zone.classList.add('dragging'); });
  for (const event of ['dragleave', 'drop']) on(zone, event, () => zone.classList.remove('dragging'));
  on(zone, 'drop', event => {
    event.preventDefault();
    if (controller.isBusy() || !event.dataTransfer.files.length) return;
    byId('file').files = event.dataTransfer.files; controller.chooseFile();
  });
  return () => cleanups.forEach(cleanup => cleanup());
}
