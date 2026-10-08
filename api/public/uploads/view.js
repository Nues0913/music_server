export function createUploadView(document) {
  const byId = id => document.getElementById(id);
  const input = byId('file'), status = byId('status'), progress = byId('progress');
  return {
    values: () => ({ file: input.files[0], title: byId('title').value, artist: byId('artist').value, token: byId('token').value }),
    message(text, state = '') { status.textContent = text; status.parentElement.className = `result ${state}`; },
    selected(file) { byId('file-label').textContent = file.name; byId('file-detail').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MiB`; byId('song-result').textContent = ''; },
    busy(busy, enabled) {
      for (const id of ['file', 'title', 'artist', 'token', 'clear-token']) byId(id).disabled = busy;
      byId('submit').disabled = busy || !enabled; byId('cancel').hidden = !busy;
    },
    progress(value) { progress.hidden = false; progress.value = value; },
    hideProgress() { progress.hidden = true; },
    clearResult() { byId('song-result').textContent = ''; },
    result(result) { byId('song-result').textContent = `${result.song.title}${result.song.artist ? ' — ' + result.song.artist : ''} · ID：${result.id}${result.song.status === 'disabled' ? '（目前已停用）' : ''}`; },
    resetFile() { input.value = ''; byId('title').value = ''; byId('artist').value = ''; byId('file-label').textContent = '繼續選擇下一首歌曲'; },
    configure(maxBytes, enabled) { byId('limit').textContent = enabled ? `每首音檔上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB` : '此服務未開啟網頁上傳。'; },
    configFailed() { byId('limit').textContent = '無法讀取上傳限制。'; },
  };
}

export function bindUploadEvents(document, controller, view) {
  const byId = id => document.getElementById(id), zone = byId('drop-zone');
  const cleanups = [];
  function on(element, event, handler) { element.addEventListener(event, handler); cleanups.push(() => element.removeEventListener(event, handler)); }
  on(byId('file'), 'change', controller.chooseFile);
  on(byId('clear-token'), 'click', () => { byId('token').value = ''; byId('token').focus(); });
  on(byId('cancel'), 'click', controller.cancel);
  on(byId('upload-form'), 'submit', event => { event.preventDefault(); void controller.submit(); });
  for (const event of ['dragenter', 'dragover']) on(zone, event, e => { e.preventDefault(); if (!controller.isBusy()) zone.classList.add('dragging'); });
  for (const event of ['dragleave', 'drop']) on(zone, event, () => zone.classList.remove('dragging'));
  on(zone, 'drop', event => {
    event.preventDefault();
    if (controller.isBusy()) return;
    if (event.dataTransfer.files.length !== 1) return view.message('每次請選擇一首歌曲。', 'error');
    byId('file').files = event.dataTransfer.files; controller.chooseFile();
  });
  return () => cleanups.forEach(cleanup => cleanup());
}
