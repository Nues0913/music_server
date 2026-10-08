export function createUploadClient({ fetch = globalThis.fetch, XMLHttpRequest = globalThis.XMLHttpRequest,
  FormData = globalThis.FormData } = {}) {
  return {
    async config() {
      const response = await fetch('/admin/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('設定讀取失敗');
      return response.json();
    },
    upload({ file, title, artist, token, onProgress }) {
      const xhr = new XMLHttpRequest();
      const data = new FormData();
      data.append('title', title.trim()); data.append('artist', artist.trim()); data.append('file', file);
      const done = new Promise((resolve, reject) => {
        xhr.open('POST', '/v1/songs');
        xhr.setRequestHeader('Authorization', `Bearer ${token.trim()}`);
        xhr.timeout = 900000;
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
        };
        xhr.onload = () => {
          let result;
          try { result = JSON.parse(xhr.responseText); }
          catch { return reject(new Error(`伺服器回應異常（${xhr.status}），請稍後重試。`)); }
          if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(
            typeof result?.error === 'string' ? result.error : '上傳失敗，請稍後重試。'));
          if (!result?.song || typeof result.song.title !== 'string') return reject(new Error('伺服器回應異常，請稍後重試。'));
          resolve(result);
        };
        xhr.onerror = () => reject(new Error('連線中斷，請確認服務後重試；相同音檔不會重複入庫。'));
        xhr.ontimeout = () => reject(new Error('上傳逾時，請稍後重試。'));
        xhr.onabort = () => reject(Object.assign(new Error('已取消傳送。若伺服器已完成入庫，重試會顯示重複歌曲。'), { cancelled: true }));
        xhr.send(data);
      });
      return { done, abort: () => xhr.abort() };
    },
  };
}
