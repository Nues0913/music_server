'use strict';
const byId = id => document.getElementById(id);
const form = byId('upload-form');
const fileInput = byId('file');
const status = byId('status');
const submit = byId('submit');
const cancel = byId('cancel');
const progress = byId('progress');
let maxBytes = 0;
let enabled = false;
let active;
const extensions = /\.(mp3|flac|wav|ogg|opus|m4a|webm)$/i;

function message(text, state = '') {
  status.textContent = text;
  status.parentElement.className = `result ${state}`;
}
function chooseFile() {
  const file = fileInput.files[0];
  if (!file) return;
  byId('file-label').textContent = file.name;
  byId('file-detail').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MiB`;
  byId('song-result').textContent = '';
  if (!extensions.test(file.name)) message('不支援此格式，請選擇音訊檔案。', 'error');
  else if (!file.size || file.size > maxBytes) message('音檔為空或超過大小上限。', 'error');
  else message('音檔已選擇，可以填寫資訊並上傳。');
}
function setBusy(busy) {
  for (const id of ['file', 'title', 'artist', 'token', 'clear-token']) byId(id).disabled = busy;
  submit.disabled = busy || !enabled;
  cancel.hidden = !busy;
}
fileInput.addEventListener('change', chooseFile);
byId('clear-token').addEventListener('click', () => { byId('token').value = ''; byId('token').focus(); });
cancel.addEventListener('click', () => active?.abort());
const zone = byId('drop-zone');
for (const event of ['dragenter', 'dragover']) zone.addEventListener(event, e => { e.preventDefault(); if (!active) zone.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) zone.addEventListener(event, () => zone.classList.remove('dragging'));
zone.addEventListener('drop', event => {
  event.preventDefault();
  if (active) return;
  if (event.dataTransfer.files.length !== 1) return message('每次請選擇一首歌曲。', 'error');
  fileInput.files = event.dataTransfer.files;
  chooseFile();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (active || !enabled) return;
  const file = fileInput.files[0];
  if (!file || !extensions.test(file.name) || !file.size || file.size > maxBytes) return message('請選擇符合格式與大小限制的音檔。', 'error');
  const data = new FormData();
  data.append('title', byId('title').value.trim());
  data.append('artist', byId('artist').value.trim());
  data.append('file', file);
  const xhr = new XMLHttpRequest();
  active = xhr;
  xhr.open('POST', '/v1/songs');
  xhr.setRequestHeader('Authorization', `Bearer ${byId('token').value.trim()}`);
  xhr.timeout = 900000;
  xhr.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    const percent = Math.min(100, Math.round(e.loaded / e.total * 100));
    progress.value = percent;
    message(percent === 100 ? '傳送完成，正在驗證並加入曲庫…' : `正在上傳 ${percent}%`);
  };
  xhr.onload = () => {
    let result;
    try { result = JSON.parse(xhr.responseText); } catch { return message(`伺服器回應異常（${xhr.status}），請稍後重試。`, 'error'); }
    if (xhr.status < 200 || xhr.status >= 300) return message(result.error || '上傳失敗，請稍後重試。', 'error');
    const duplicate = result.status === 'duplicate';
    message(duplicate ? '曲庫已有相同音檔，未重複新增。' : '歌曲已加入曲庫！', 'success');
    byId('song-result').textContent = `${result.song.title}${result.song.artist ? ' — ' + result.song.artist : ''} · ID：${result.id}${result.song.status === 'disabled' ? '（目前已停用）' : ''}`;
    if (!duplicate) { fileInput.value = ''; byId('title').value = ''; byId('artist').value = ''; byId('file-label').textContent = '繼續選擇下一首歌曲'; }
  };
  xhr.onerror = () => message('連線中斷，請確認服務後重試；相同音檔不會重複入庫。', 'error');
  xhr.ontimeout = () => message('上傳逾時，請稍後重試。', 'error');
  xhr.onabort = () => message('已取消傳送。若伺服器已完成入庫，重試會顯示重複歌曲。');
  xhr.onloadend = () => { active = undefined; setBusy(false); progress.hidden = true; };
  setBusy(true); progress.hidden = false; progress.value = 0; byId('song-result').textContent = '';
  message('正在上傳…'); xhr.send(data);
});
fetch('/admin/config').then(response => {
  if (!response.ok) throw new Error();
  return response.json();
}).then(config => {
  maxBytes = config.maxBytes; enabled = config.enabled;
  byId('limit').textContent = `每首最多 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB，每次一首。`;
  submit.disabled = !enabled;
  if (!enabled) message('管理者尚未啟用上傳服務。', 'error');
}).catch(() => message('無法連線到服務，請重新整理頁面。', 'error'));
