# Linux 測試

所有測試、合成音檔工具與記憶體檢查集中在本目錄。以下 Node.js 指令從 `api/` 執行。

## 整合測試

```bash
npm ci
npm run db:generate
npm run build
npm test
```

使用獨立暫存 SQLite，測試授權、中文搜尋、分頁、匯入／上傳去重、停用、路徑與容量限制、metadata、失敗清理及 HTTP 中斷。

## 經 Nginx 測試

先依根目錄 README 啟動 Linux API 與一個 Nginx 入口：

```bash
npm run test:fixture
npm run import
npm run test:smoke
npm run test:upload
```

Docker 曲庫則使用 `npm run test:fixture -- ../data/container/inbox`，再從根目錄執行 `docker compose exec api node dist/cli.js import`。

`test:smoke` 檢查健康、授權、中文搜尋、SHA-256、HEAD、Range 206、私有目錄與並行串流。`test:upload` 檢查 16 MiB 串流上傳、大小與 SHA-256。

預設入口為 `http://127.0.0.1`；可設定 `SMOKE_URL=https://music.example.com`。測試金鑰預設讀 `api/.env`；測 Docker 時若金鑰不同，以環境變數提供 API_TOKEN／ADMIN_TOKEN。瀏覽器測試需要 `data/inbox` 的合成音檔，使用 Docker 曲庫時也執行一次不帶參數的 `test:fixture`。

## 瀏覽器上傳

先安裝 Chromium，再執行：

```bash
BROWSER_PATH=/usr/bin/chromium npm run test:browser
```

測試上傳權限、metadata、金鑰清除、localStorage 與桌面／手機版面；截圖位於 `api/test/results/`。測試會在目前曲庫加入合成音檔，可用 CLI 停用。

## 記憶體檢查

Docker 執行中的 Linux 主機：

```bash
npm run test:memory
```

同時顯示容器用量與主機 `MemTotal - MemAvailable`。單次快照不代表峰值；在冷啟動、匯入、上傳、並行播放與長時間暫停期間重複量測，檢查是否 OOM。低於 500 MB 的要求針對整台主機，Compose 的限制不包含建置程序。

## Nginx 網域與串流

需要 Docker、Python 3 與 OpenSSL，在專案根目錄執行：

```bash
python3 api/test/nginx.py
```

使用 Pebble 私人測試 CA，驗證 Nginx 從零透過 HTTP-01 取得憑證、容器重建後載入既有憑證及短效憑證自動續期，並測試 HTTP／HTTPS、網域限制、代理標頭、上傳與 Range。測試不連正式 Let's Encrypt，完成後清除測試容器、網路與憑證 volume。


## 架構重構檢查

`npm run check:architecture` 檢查依賴方向與 runtime import 循環。`npm run test:unit` 使用 fixture 測 HTTP、管理頁、清單規則及真實 SQLite migration SQL，不需 Prisma 原生引擎；Chromium 可用 BROWSER_PATH 指定。這些測試不替代上方的 Prisma transaction／容量／持久化整合測試。
