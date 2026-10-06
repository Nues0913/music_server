# Oracle 遠端音樂曲庫

**工作流：Windows 本機開發 Fastify API → Nginx 容器串流測試 → 完整 Docker Compose 打包與部署。** 本機需要 Node.js（22.12+，本次使用既有 24.19.0），不用安裝 SQLite 系統軟體。Prisma 直接讀寫 `.db`，npm、tsx、TypeScript 與 Prisma 日常指令在本機執行。

目標環境：**Oracle 免費方案、Ubuntu 24.04、2 core、1 GB RAM、1 GB Swap**。硬需求：RAM 低於 **500 MB**、保留既有 Swap、使用 **Fastify + Prisma + Docker Compose**。SQLite 存歌曲資訊，私有目錄存音檔，Nginx 傳送串流。Discord Bot／FFmpeg 在另一台主機。

目前已實作搜尋／播放／上傳 API、網頁上傳、匯入／停用 CLI、migration、Nginx 與容器設定。Oracle、HTTPS、長時間播放與 Discord 語音整合仍待驗收。`參考用前端源碼/` 僅供唯讀參考，不在 Docker build context 內。

## 專案結構

```text
music_server/                  # 目前資料夾就是專案根目錄
├── docker-compose.yml         # 完整 API + Nginx
├── docker-compose.nginx.yml   # Nginx → Windows API
├── .env.example               # Compose 設定
├── api/
│   ├── Dockerfile
│   ├── package.json / package-lock.json
│   ├── .env.example           # 本機設定
│   ├── prisma/                # Schema 與 migration
│   ├── src/                   # Fastify、Prisma、CLI
│   ├── test/                  # SQLite 整合測試
│   └── scripts/               # 合成音檔／串流測試
├── nginx/                     # 共用設定及上游模板
├── scripts/setup.ps1          # Windows 初始化
├── scripts/setup.sh           # Linux 初始化
├── data/                      # 不提交版本控制
│   ├── db/ audio/ inbox/      # Windows 本機資料
│   └── container/             # 容器自己的 db/ audio/ inbox/
└── 參考用前端源碼/              # 唯讀
```

Windows 與完整容器使用不同資料目錄，避免跨平台同時開啟同一個 SQLite。音檔從 inbox 複製至 audio，原始檔保留。

## 1. 本機開發

在根目錄的 PowerShell 執行：

```powershell
node --version
npm.cmd --version
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
Set-Location api
npm.cmd install
npm.cmd run db:generate
npm.cmd run db:push
npm.cmd run dev
```

setup 建立缺少的資料夾、根目錄 `.env` 與 `api/.env`，產生隨機 token，不顯示 token 或覆寫既有設定。Bypass 只影響該次程序。`npm.cmd` 避免 Windows npm.ps1 執行原則限制。

`db:push` 即 `npx prisma db push`；`dev` 使用 `tsx watch src/server.ts`。也可 `npx.cmd tsx src/server.ts`，入口為 `http://127.0.0.1:3000`。

本機設定含 `RUST_LOG=info`，處理本次 Windows Prisma 首次建 DB 時只有空白錯誤的行為。Prisma／Client 均固定 6.19.3，無需全域安裝。開發 DB 用 db push；正式 DB 用 migration，不直接搬用開發 DB。

```powershell
# api/ 目錄
npm.cmd run build
npm.cmd test
```

測試用獨立暫存 SQLite，涵蓋授權、中文搜尋、分頁、匯入去重、停用、路徑限制、磁碟／配額限制與失敗清理。

### Linux 本機開發（Ubuntu 24.04）

本機先安裝 Node.js 22.12+ 與 npm；需要 Nginx 串流測試時另安裝 Docker Engine 與 Compose plugin，不需安裝系統 SQLite。在專案根目錄執行：

```bash
node --version
npm --version
bash scripts/setup.sh
cd api
npm install
npm run db:generate
npm run db:push
npm run dev
```

`setup.sh` 與 PowerShell 初始化用途相同：建立資料目錄與缺少的設定、產生隨機金鑰、保留已有設定，不輸出金鑰。新建的 `.env` 權限為 600。腳本使用 Node.js 的加密功能，不需要額外安裝工具；可從任意工作目錄呼叫。

Linux 也使用 `data/db`、`data/audio`、`data/inbox` 作為本機資料。不要共用 Windows 的 `node_modules`；在 Linux 環境重新安裝套件及產生 Prisma Client。

若要讓 Linux Docker Engine 的 Nginx 連到本機 API，先停止上述 API，再從 `api/` 執行：

```bash
HOST=0.0.0.0 npm run dev
```

另開終端機，在專案根目錄執行：

```bash
docker compose -f docker-compose.nginx.yml up -d
```

Compose 已加入 `host.docker.internal:host-gateway`，讓 Linux 容器能找到宿主機；Linux 的 API 不能只綁 `127.0.0.1`，因此上面覆寫 HOST。這會讓 3000 埠監聽所有介面，開發機防火牆應限制外部存取並允許 Docker 網橋連線。上傳入口仍為 `http://127.0.0.1:8080/admin`。

Linux 的匯入、測試與 Studio 指令與 Windows 相同，只需把 `npm.cmd` 換成 `npm`。例如在 `api/` 執行 `npm run import`、`npm test`、`npm run db:studio`。正式部署仍使用 `docker compose up -d --build`，不需要啟動本機 API。

## 2. 本機 API + Nginx 容器

啟動 Docker Desktop（Linux containers），保持 API 執行；另一個 PowerShell 在根目錄執行：

```powershell
docker compose -f docker-compose.nginx.yml up -d
```

Nginx 透過 `host.docker.internal:3000` 連回 Windows，入口為 `http://127.0.0.1:8080`，唯讀掛載 `data/audio`。API 回傳 `/protected-audio/{fileKey}`，Nginx 從 `/srv/music-audio` 讀取，不要求 Windows 與 Linux 路徑一致。直接呼叫 API 的音檔路由只取得 X-Accel-Redirect；完整串流須經 Nginx。

```powershell
# api/ 目錄，產生兩秒合成 WAV 並測試
node scripts/make-fixture.mjs
npm.cmd run import
npm.cmd run test:smoke
```

驗證完整音檔 SHA-256、HEAD、Range（206）、授權、私有目錄及兩路並行串流。短音檔測試不代表長時間播放已驗收；合成音檔留在開發曲庫，可用 CLI 停用。

## 3. 完整容器打包

停止本機 API（Ctrl+C），在根目錄執行：

```powershell
docker compose -f docker-compose.nginx.yml down
docker compose up --build -d
docker compose ps
docker compose logs --tail=50 api
```

Dockerfile 在 Linux 內執行 npm ci、Prisma generate 與 TypeScript 編譯。`.dockerignore` 排除本機 node_modules、.env、測試 DB 與 dist；`binaryTargets = ["native"]` 在各自建置環境生成引擎。Windows 的 Prisma 二進位檔不帶入映像。

API 啟動前執行 `prisma migrate deploy`，成功後啟動；Nginx 等待健康檢查。容器資料持久保存於 `data/container`，不要以本機 db push 的 DB 覆蓋。

```powershell
# 音檔放入 data/container/inbox 後匯入
docker compose exec api node dist/cli.js import

# 容器串流測試
node api/scripts/make-fixture.mjs data/container/inbox
docker compose exec api node dist/cli.js import
Set-Location api
npm.cmd run test:smoke
Set-Location ..
docker stats --no-stream
```

回本機開發前先 `docker compose down`，再啟動本機 API 與半容器 Nginx。兩種模式共用 8080，不同時啟動。

## 4. 部署到 Linux／Oracle Ubuntu 24.04

正式主機需要 **Docker Engine、Compose plugin**，用 Git 取得程式時另需 Git。不需要安裝 Node.js、npm 或 SQLite，也不需要執行 `setup.sh`、`db:push` 或 `npm run dev`。正式環境只使用 `docker-compose.yml`。

### 4.1 準備 Linux 主機與專案

Windows PowerShell，將私鑰及 IP 換成自己的：

```powershell
ssh -i C:\Keys\oracle.key ubuntu@<Oracle公網IP>
```

依 [Docker 官方 Ubuntu 安裝步驟](https://docs.docker.com/engine/install/ubuntu/) 安裝 Docker Engine 與 Compose plugin。Ubuntu 使用 Docker Engine，不安裝 Docker Desktop；已有 Docker 時先確認，不直接移除既有套件。以下 Bash 指令在 Linux 主機執行：

```bash
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
uname -m
free -m
swapon --show
sudo apt-get update
sudo apt-get install -y git openssl curl
git clone <你的Git-repository-URL> ~/music_server
cd ~/music_server
```

本節使用 `sudo docker`，不要求加入 Docker 群組。保留既有 1 GB Swap。`x86_64` 對應 image 的 `linux/amd64`，`aarch64` 對應 `linux/arm64`。

先將專案提交到自己的 repository，不提交 `.env`、音檔與 DB。也可用 SCP/SFTP 傳送部署檔案：`docker-compose.yml`、`.env.example`、`nginx/`，以及 `api/` 的 Dockerfile、.dockerignore、package.json、package-lock.json、tsconfig.json、src、public、prisma。不要傳送 Windows 的 node_modules、dist、api/.env 或開發 DB。

### 4.2 建立正式設定

在 Linux 專案根目錄執行：

```bash
umask 077
mkdir -p data/container/{db,audio,inbox}
chmod 755 data/container/audio
if [ ! -e .env ]; then
  cp .env.example .env
  sed -i "s/^API_TOKEN=.*/API_TOKEN=$(openssl rand -hex 32)/" .env
  sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
fi
chmod 600 .env
nano .env
```

只有缺少 `.env` 時才產生金鑰，不輸出或覆寫既有金鑰。確認金鑰不是範本的 `replace-with-...`，兩個金鑰必須不同。先保留 `HTTP_BIND=127.0.0.1`、`HTTP_PORT=8080` 與 `MUSIC_DATA_ROOT=./data/container`。正式上傳使用**根目錄 `.env` 的 ADMIN_TOKEN**；Bot 搜尋／播放使用該檔的 API_TOKEN。

### 4.3 建置與啟動

**建議在 Windows 建置 Linux image，再傳到 Oracle**，避免 1 GB 主機進行 npm 安裝與 TypeScript 編譯。下面以 Oracle x86_64 為例；ARM 主機把 platform 改成 `linux/arm64`。

Windows PowerShell，在專案根目錄：

```powershell
docker buildx build --platform linux/amd64 --load -t remote-music-api:release-001 ./api
docker image save -o "$env:TEMP\remote-music-api-release-001.tar" remote-music-api:release-001
scp -i C:\Keys\oracle.key "$env:TEMP\remote-music-api-release-001.tar" ubuntu@<Oracle公網IP>:~/
```

Linux 主機：

```bash
cd ~/music_server
sudo docker image load -i ~/remote-music-api-release-001.tar
sed -i 's/^MUSIC_API_IMAGE=.*/MUSIC_API_IMAGE=remote-music-api:release-001/' .env
sudo docker compose pull nginx
sudo docker compose up -d --no-build --pull never
sudo docker compose ps
sudo docker compose logs --tail=50 api
curl --fail http://127.0.0.1:8080/health
```

程式 image 與專案設定應來自同一版本。`--no-build` 避免 Oracle 建置，`--pull never` 使用已載入的 API 與已下載的 Nginx image。也可使用 Docker Hub／其他 registry 傳送 image；歌曲及 DB 不隨 image 傳送。

若接受主機建置的資源需求，也可以省略 image 傳送，直接在 Linux 執行 `sudo docker compose up -d --build`；服務的記憶體限額不限制建置程序，不保證 1 GB 主機能完成或低於 500 MB。

API 初次啟動自動執行 migration 建立正式 DB，以後只套用尚未執行的 migration。若 unhealthy，查看日誌，不使用 `db:push` 修改正式 DB。

### 4.4 從 Windows 使用 Oracle 上傳頁

使用 SSH tunnel，可先不公開 8080 或另外配置 HTTPS。Windows 另開 PowerShell 並保持連線：

```powershell
ssh -i C:\Keys\oracle.key -N -L 18080:127.0.0.1:8080 ubuntu@<Oracle公網IP>
```

開啟 **http://127.0.0.1:18080/admin**，輸入 Oracle 根目錄 `.env` 的 ADMIN_TOKEN，操作的是 Oracle 曲庫。使用 18080 避免與 Windows 開發的 8080 衝突。

遠端 Bot 長期連線可使用私有 VPN，或另行配置網域與 HTTPS 入口轉送到本機 8080。當前 Compose 沒有 TLS 設定，改成 `HTTP_BIND=0.0.0.0` 不會自動取得 HTTPS。公開 HTTPS 還需設定 OCI Security List／NSG 入站規則與主機防火牆；不需要公開內部 API 3000、Studio 5555 或 8080。[OCI Security Lists 文件](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm)

### 4.5 新增與搬移歌曲

直接用上傳頁，或把音檔傳到 `~/music_server/data/container/inbox/`，再執行：

```bash
cd ~/music_server
sudo docker compose exec api node dist/cli.js import
```

搬移已有的完整容器曲庫時，先停止來源 API 與所有匯入工作，再備份整個 `data/container`，於目標容器停止時還原。DB 與 audio 必須配對，SQLite WAL／SHM 也要保留。不要將本機 db:push 的開發 DB 當作 migration 管理的正式 DB；開發音檔可重新上傳或匯入。

### 4.6 備份、更新與記憶體驗收

在 Linux 專案根目錄，以下使用預設 MUSIC_DATA_ROOT；自訂路徑時一起修改備份來源：

```bash
umask 077
mkdir -p ~/music-backups
sudo docker compose down
sudo tar -czf "$HOME/music-backups/music-$(date +%Y%m%d-%H%M%S).tar.gz" data/container .env
sudo docker compose up -d --no-build --pull never
```

備份包含金鑰，請保護並另存其他主機；tar 失敗需排查，不視為完成。停止期間不可另外匯入。`down` 不會刪除 bind mount 資料；還原先在獨立目錄驗證，再於容器停止時處理正式資料。

更新前先備份。Windows 用新標籤（例如 release-002）建置並傳送 image。Oracle 使用 `git pull --ff-only` 取得對應版本、`sudo docker image load` 載入 image，修改 .env 的 MUSIC_API_IMAGE，再執行：

```bash
sudo docker compose up -d --no-build --pull never
sudo docker compose ps
curl --fail http://127.0.0.1:8080/health
sudo docker compose logs --tail=50 api
sudo docker stats --no-stream
free -m
awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {used=(total-available)*1024; printf "Host used: %.0f bytes; below 500 MB: %s\n", used, used<500000000 ? "yes" : "no"}' /proc/meminfo
```

最後一行是整機當下用量，還需在啟動、上傳、匯入與並行播放時驗收峰值。migration 已變更 DB 時，切回舊 image 不保證能回退，需評估相容性或還原更新前配對的備份。目前尚未在你的 Oracle 實機部署或完成 500 MB 驗收。

## 網頁與 API 上傳

開啟 **http://127.0.0.1:8080/admin**，選擇／拖曳音檔、選填歌名與演出者，輸入 **ADMIN_TOKEN 的值**（本機模式讀 `api/.env`；完整 Docker 模式讀根目錄 `.env`），按「上傳歌曲」。支援進度、取消與去重；每次一首，最多 256 MiB（也受 MAX_AUDIO_BYTES 較低設定限制）。金鑰不存入 localStorage／cookie，重新開頁需再次輸入。

ADMIN_TOKEN 為獨立上傳憑證，API_TOKEN 僅用於搜尋／播放。setup.ps1 會補上缺少的管理金鑰，不覆寫已有金鑰；變更設定後需重啟 API，容器可用 `docker compose up -d` 套用。

API：`POST /v1/songs`，multipart/form-data，欄位 `file`（必填）、`title`、`artist`（選填，各最多 500 字元）。留空沿用音檔標籤或原始檔名。Header：`Authorization: Bearer <ADMIN_TOKEN>`。

```powershell
# api/ 目錄，金鑰讀入變數，不顯示於終端
$uploadToken = (Get-Content .env | Where-Object { $_ -match '^ADMIN_TOKEN=' }) -replace '^ADMIN_TOKEN=', ''
curl.exe -H "Authorization: Bearer $uploadToken" -F "file=@C:\Music\song.mp3" -F "title=歌曲名稱" -F "artist=演出者" http://127.0.0.1:8080/v1/songs
```

新增回傳 201：`{status:"imported",id,song}`；同雜湊回傳 200：`{status:"duplicate",id,song}`，不覆寫既有資料或停用狀態。錯誤：401 金鑰、400 無效音訊／欄位、413 超限、415 格式、409 正在上傳／匯入、507 空間／配額不足。

上傳串流寫入私有暫存，不使用整首 RAM buffer；每個 API 程序僅一筆上傳，Nginx 關閉 request buffering。完整檔案與所有欄位驗證後才入庫，取消／失敗清理暫存。磁碟需容納暫存與匯入副本（最多兩倍單檔大小），另保留 MIN_FREE_BYTES。

### Prisma Studio

你記得的 GUI 很可能是 **Prisma Studio**。它可查看／編輯資料庫，不會替本專案處理音檔上傳、私有目錄與雜湊；新增音檔用上傳頁，查看資料可用 Studio。[官方文件](https://www.prisma.io/docs/orm/v6/tools/prisma-studio)

```powershell
# api/ 目錄
npm.cmd run db:studio
```

瀏覽 **http://127.0.0.1:5555**。只綁 localhost，連至 Windows 開發 DB；Studio 不作為 Oracle 常駐或公開服務。不要手動新增只有資料列而無音檔的曲目，也不要隨意更改 fileKey／sha256。

### 上傳驗證

`npm.cmd test` 包含權限、去重、metadata、非法格式、超限、清理與真實 HTTP 中斷。`npm.cmd run test:browser` 用本機 Edge headless 實際操作上傳頁，產生桌面／手機截圖至 data/verification；需先產生合成 WAV 並啟動 API／Nginx。BROWSER_PATH 可改用其他 Chromium 瀏覽器。

## API 與匯入

`/v1` 搜尋／播放使用 `Authorization: Bearer <API_TOKEN>`；POST 上傳使用獨立 ADMIN_TOKEN。根目錄與 api/.env 的對應金鑰須一致，均不提交版本控制。JSON 使用 camelCase，不回傳 fileKey／磁碟路徑。

| API | 用途 |
| --- | --- |
| GET /health | DB 與歌曲表可用時 200，否則 503 |
| POST /v1/songs | 使用 ADMIN_TOKEN，以 multipart 上傳音檔與選填標題／演出者 |
| GET /v1/songs?query=&cursor=&limit=25 | 標題／演出者部分搜尋，僅啟用曲目；items 與 nextCursor，每頁 1–25 首 |
| GET /v1/songs/:id | ID、標題、演出者、時長、MIME、大小、SHA-256、更新時間 |
| GET /v1/songs/:id/audio | 檢查狀態、路徑、大小，再由 Nginx 傳檔 |
| HEAD /v1/songs/:id/audio | 經 Nginx 取得完整 Content-Length，仍需授權 |

Nginx 支援單一 Range，私有路徑為 internal。SQLite 使用 WAL、單一連線、有界快取。一般索引不保證加速任意中文子字串搜尋。

匯入只掃 inbox 第一層，支援 mp3、flac、wav、ogg、opus、m4a、webm。流程：檔案／容量檢查 → 串流複製及 SHA-256 → metadata 辨識 → 私有檔案改名 → Prisma 建檔。同雜湊不重複匯入，失敗清理暫存且不產生可見曲目。

目前驗證格式、metadata 與大小，**尚未整首解碼驗證**；metadata 可讀不保證每個 frame 可播放。可後續在開發主機加入匯入前解碼驗證。

```powershell
# api/ 目錄
npm.cmd run import
npm.cmd run cli -- disable <song-id>
npm.cmd run cli -- enable <song-id>
# 根目錄，容器模式
docker compose exec api node dist/cli.js disable <song-id>
docker compose exec api node dist/cli.js enable <song-id>
```

停用後拒絕新請求、保留檔案，不中斷已開始的串流；尚無實體刪除 CLI。匯入用 `.import-lock` 防止並行；若異常退出留下鎖，確認無匯入工作後再清理鎖與孤立 .part。

| 設定 | 預設 |
| --- | --- |
| MAX_AUDIO_BYTES | 256 MiB／首 |
| MIN_FREE_BYTES | 匯入後保留 512 MiB 磁碟 |
| LIBRARY_QUOTA_BYTES | 10 GiB，含停用曲目 |
| MUSIC_DATA_ROOT | Compose 資料根目錄，./data/container |
| HTTP_BIND／HTTP_PORT | 127.0.0.1／8080 |

本機設定放 api/.env；Compose 設定放根目錄 .env，容器配額由 Compose 傳入 API environment。

## 資源限制與 Oracle

API 限 **256 MiB RAM／128 MiB V8 heap**；Nginx 限 **48 MiB RAM／1 worker**，有界連線與速率。memswap_limit 等於 mem_limit，容器不用 Swap；Oracle 保留既有 1 GB Swap。TypeScript 建置階段使用 256 MiB heap，與執行階段分開。

Oracle 整機以 `MemTotal - MemAvailable` 低於 **500,000,000 bytes（約 476.8 MiB）** 驗收，包含 Ubuntu、Docker 與管理工作。容器上限合計 304 MiB，剩餘約 172.8 MiB 給主機；此為預算，**達標與否仍須實機量測**。V8 heap 不等於 RSS，docker stats 也不是整機用量。

Windows 開發機不套用 Oracle 整機上限。Oracle 驗收須記錄冷啟動、長短音檔、搜尋、匯入、並行播放與暫停的主機／cgroup 峰值，檢查 OOM。若並行匯入超標，先停止 API，再 `docker compose run --rm --no-deps api node dist/cli.js import`。

Oracle 可用同份 Compose 建置，但 **Compose 服務限額不限制 BuildKit**；本機成功不保證雲端資源足夠。建議在開發機／CI 建置符合 Oracle 架構的映像、發布固定 tag／digest，再於 Oracle 拉取啟動。建置及執行的資源用量都須驗證。

預設 HTTP 僅綁 localhost。對外部署需 HTTPS 或私有 VPN，完成後再調整 HTTP_BIND 與網路規則；API 不公開宿主機連接埠。

備份先停止 API 與匯入，再備份完整資料目錄（DB 含 WAL／SHM 與 audio），還原至獨立目錄驗證。不要在寫入中只複製 songs.db；線上備份與還原自動化尚待實作。

## 後續 Discord Bot 整合

未修改參考 Bot。後續新增 source: local | remote（預設本地）、共用 Track 與混排，保留權限、循環、音量、25 首曲庫／10 首佇列分頁、100 首待播、15 分鐘選單期限與本地 reload。

Bot HTTP 串流送至 FFmpeg stdin，以背壓控制緩衝；暫停達 10 分鐘主動清理，Nginx send_timeout 15m 作閒置保護。跳歌／停止取消 HTTP 與 FFmpeg，連續三首失敗停止；此部分尚待 Discord 實作與驗收。
