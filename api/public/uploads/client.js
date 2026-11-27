const jobIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const retryablePollStatuses = new Set([429, 502, 503, 504, 524]);
const cancelled = () => Object.assign(new Error('已取消上傳。若歌曲已入庫，重試會顯示重複歌曲。'), { cancelled: true });

function waitForPoll(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createUploadClient({ fetch = globalThis.fetch, XMLHttpRequest = globalThis.XMLHttpRequest,
  FormData = globalThis.FormData, pollIntervalMs = 1000 } = {}) {
  async function pollResult(url, authorization, controller) {
    const { signal } = controller;
    const deadline = setTimeout(() => controller.abort(new Error('等待結果逾時，請先搜尋曲庫確認歌曲是否已加入。')), 11 * 60_000);
    try {
      while (true) {
        signal.throwIfAborted();
        let response;
        try { response = await fetch(url, { headers: { Authorization: authorization }, cache: 'no-store', signal }); }
        catch { if (signal.aborted) throw signal.reason; }
        // Retrying a status read is safe even if a proxy interrupted the previous request.
        if (!response || retryablePollStatuses.has(response.status)) {
          await waitForPoll(pollIntervalMs, signal);
          continue;
        }
        const job = await response.json().catch(() => null);
        signal.throwIfAborted();
        if (!response.ok) throw Object.assign(new Error(job?.error ?? '無法查詢上傳結果。'), { status: response.status });
        if (job?.state === 'complete' && typeof job.result?.song?.title === 'string') return job.result;
        if (job?.state === 'failed') throw Object.assign(new Error(job.error), { status: job.status });
        if (job?.state === 'cancelled') throw cancelled();
        if (job?.state !== 'processing') throw new Error('伺服器回傳的上傳狀態無效。');
        await waitForPoll(pollIntervalMs, signal);
      }
    } finally { clearTimeout(deadline); }
  }
  return {
    async config() {
      const response = await fetch('/admin/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('設定讀取失敗');
      return response.json();
    },
    upload({ file, title, artist, token, onProgress }) {
      const xhr = new XMLHttpRequest();
      const authorization = `Bearer ${token.trim()}`;
      const polling = new AbortController();
      let jobUrl;
      const data = new FormData();
      data.append('title', title.trim()); data.append('artist', artist.trim()); data.append('file', file);
      const done = new Promise((resolve, reject) => {
        xhr.open('POST', '/v1/songs');
        xhr.setRequestHeader('Authorization', authorization);
        xhr.setRequestHeader('Prefer', 'respond-async');
        xhr.timeout = 900000;
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
        };
        xhr.onload = () => {
          let result;
          const retryAfter = xhr.getResponseHeader?.('Retry-After') ?? undefined;
          try { result = JSON.parse(xhr.responseText); }
          catch { return reject(Object.assign(new Error(`伺服器回應異常（${xhr.status}），請稍後重試。`), { status: xhr.status, retryAfter })); }
          if (xhr.status < 200 || xhr.status >= 300) return reject(Object.assign(new Error(
            typeof result?.error === 'string' ? result.error : '上傳失敗，請稍後重試。'), { status: xhr.status, retryAfter }));
          if (xhr.status === 202 && typeof result?.jobId === 'string' && jobIdPattern.test(result.jobId)) {
            jobUrl = `/v1/song-uploads/${result.jobId}`;
            return resolve(pollResult(jobUrl, authorization, polling));
          }
          if (!result?.song || typeof result.song.title !== 'string') return reject(new Error('伺服器回應異常，請稍後重試。'));
          resolve(result);
        };
        xhr.onerror = () => reject(new Error('連線中斷，請確認服務後重試；相同音檔不會重複入庫。'));
        xhr.ontimeout = () => reject(new Error('上傳逾時，請稍後重試。'));
        xhr.onabort = () => reject(cancelled());
        xhr.send(data);
      });
      return { done, abort() {
        if (!jobUrl) { xhr.abort(); return; }
        polling.abort(cancelled());
        void fetch(jobUrl, { method: 'DELETE', headers: { Authorization: authorization }, keepalive: true }).catch(() => {});
      } };
    },
  };
}
