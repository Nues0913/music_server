# 遠端音樂曲庫

Fastify + Prisma + SQLite 音樂 API，Nginx 負責串流。支援搜尋、播放、上傳、匯入與停用。

設定根目錄 `.env` 的 `SERVER_NAME`：

| SERVER_NAME | 入口 |
| --- | --- |
| 留空 | `http://localhost/admin` |
| `music.example.com` | `http://music.example.com/admin` 與 `https://music.example.com/admin` |

有網域時，Nginx 原生 ACME 自動申請、載入與續期 Let's Encrypt 憑證，HTTP／HTTPS 都提供服務。

## Docker 部署

需要 Docker Engine、Compose plugin 與 OpenSSL。在根目錄執行：

```bash
bash scripts/setup.sh
docker compose up -d --build
```

API 設定在根目錄 `.env`，資料在 `data/container/{db,audio,inbox}`；憑證與 ACME 帳號保存在 `nginx-acme` named volume，建置與 DB migration 自動執行。


程式碼更新與重新建置啟動
```bash
git pull --ff-only
docker compose up -d --build
```

**修改主機出口埠**

如需修改主機出口埠，修改 `docker-compose.yml` 中 `services.nginx.ports`，將主機的 HTTPS 埠從 443 改成 8443：

```yaml
    ports:
      - '${NGINX_BIND:-0.0.0.0}:80:80'
      - '${NGINX_BIND:-0.0.0.0}:8443:443'
```

Dockerfile 或 Nginx conf。套用後，使用 `https://music.example.com:8443/admin` 存取
```bash
docker compose up -d
```

若 HTTP 也要改成 8080，將第一行改為 `'${NGINX_BIND:-0.0.0.0}:8080:80'`，使用 `http://music.example.com:8080/admin`。

ACME HTTP-01 的申請與續期仍要求**外部 80 埠**能抵達容器的 80。若主機 HTTP 改為 8080，可設定路由器 `外部 80 → 主機 8080 → 容器 80`；只有外部 8080 可連入無法完成此驗證。

## Linux 本機開發

需要 Node.js 22.12+、npm 與 OpenSSL。從根目錄執行：

```bash
bash scripts/setup.sh
cd api
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

API 使用 `api/.env`，資料在 `data/{db,audio,inbox}`，監聽 `127.0.0.1:3000`。播放音檔必須經過以下其中一個 Nginx 入口。

### 本機 Nginx


1. 選擇下方的 HTTP 或 HTTP／HTTPS 版本，完成該版本的 Nginx 套件安裝。
2. 從**專案根目錄**執行以下指令，讓 Nginx 可以引用專案的共用規則：

   ```bash
   sudo mkdir -p /etc/nginx/snippets
   sudo ln -s "$PWD/nginx/locations.conf" /etc/nginx/snippets/music-locations.conf
   ```

3. 將選定版本的 conf 存成 `/etc/nginx/conf.d/music.conf`，把 `music.example.com` 換成你的網域，`/home/deploy/music_server/data/audio` 換成實際音檔目錄。
4. 完成下方的憑證目錄（HTTPS）與音檔權限設定後，再檢查並套用 Nginx 設定。

**網域 HTTP**

安裝一般 Nginx 即可，不需要 ACME 模組：`sudo apt install nginx`。

```nginx
# /etc/nginx/conf.d/music.conf
limit_conn_zone $binary_remote_addr zone=per_client:1m;
limit_req_zone $binary_remote_addr zone=api_rate:1m rate=10r/s;

server {
    listen 80 default_server;
    return 444;
}

server {
    listen 80;
    server_name music.example.com;

    set $audio_root "/home/deploy/music_server/data/audio";
    set $api_backend "127.0.0.1:3000";
    include /etc/nginx/snippets/music-locations.conf;
}
```

**網域 HTTP／HTTPS，自動取得憑證**

加入 Nginx 官方的下載來源與簽章金鑰，安裝 `sudo apt install -y nginx nginx-module-acme`，並在 `/etc/nginx/nginx.conf` 最前面載入模組：

```nginx
load_module /usr/lib/nginx/modules/ngx_http_acme_module.so;
```

```nginx
# /etc/nginx/conf.d/music.conf
resolver 1.1.1.1 valid=10s ipv6=off;
limit_conn_zone $binary_remote_addr zone=per_client:1m;
limit_req_zone $binary_remote_addr zone=api_rate:1m rate=10r/s;

acme_issuer letsencrypt {
    uri https://acme-v02.api.letsencrypt.org/directory;
    state_path /var/lib/nginx/music-acme;
    ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    accept_terms_of_service;
}

server {
    listen 80 default_server;
    return 444;
}

server {
    listen 443 ssl default_server;
    ssl_reject_handshake on;
    return 444;
}

server {
    listen 80;
    listen 443 ssl;
    server_name music.example.com;

    acme_certificate letsencrypt;
    ssl_certificate $acme_certificate;
    ssl_certificate_key $acme_certificate_key;
    ssl_certificate_cache max=2;
    ssl_protocols TLSv1.2 TLSv1.3;

    set $audio_root "/home/deploy/music_server/data/audio";
    set $api_backend "127.0.0.1:3000";
    include /etc/nginx/snippets/music-locations.conf;
}
```

建立憑證保存目錄，擁有者要與 `/etc/nginx/nginx.conf` 的 worker `user` 相同；以下以 `nginx` 為例：

```bash
sudo install -d -o nginx -m 700 /var/lib/nginx/music-acme
```

Nginx worker 必須能讀取 `data/audio` 並穿越其父目錄：
```bash
sudo apt install acl
sudo setfacl -m u:www-data:--x /home/deploy /home/deploy/music_server /home/deploy/music_server/data
# 現有音檔可讀、音檔目錄可穿越
sudo setfacl -R -m u:www-data:rX /home/deploy/music_server/data/audio
# 後續建立的音檔繼承讀取權限
sudo setfacl -m d:u:www-data:rx /home/deploy/music_server/data/audio
# 用實際音檔驗證；退出碼 0 表示可讀取
sudo -u www-data test -r /home/deploy/music_server/data/audio/example.mp3
```

網站設定、共用規則與權限都完成後，檢查並套用：

```bash
sudo nginx -t && sudo systemctl reload-or-restart nginx
```

### 使用 Docker Nginx

停止本機 API 後重新啟動，讓 Docker 網橋能連線：

```bash
cd api
HOST=0.0.0.0 npm run dev
```

另開終端機，在根目錄執行：

```bash
API_UPSTREAM=host.docker.internal:3000 MUSIC_DATA_ROOT=./data \
  docker compose up -d --no-deps nginx
```

## 上傳、匯入與停用

開啟 `/admin`，輸入 **ADMIN_TOKEN**，選擇音檔後上傳。金鑰位於目前模式的 `.env`；**API_TOKEN** 供搜尋、播放及清單管理使用，兩個金鑰須不同且至少 32 字元。

每次上傳一首，預設上限 256 MiB，支援取消、metadata 與去重；金鑰不存入瀏覽器儲存空間。留空的 title／artist 沿用音檔標籤或原始檔名。

批次匯入：將音檔放進目前模式的 inbox，再執行：

```bash
# Linux 本機：在 api/ 執行
npm run import
npm run cli -- disable <song-id>
npm run cli -- enable <song-id>

# Docker：在專案根目錄執行
docker compose exec api node dist/cli.js import
docker compose exec api node dist/cli.js disable <song-id>
docker compose exec api node dist/cli.js enable <song-id>
```

匯入只掃 inbox 第一層，支援 mp3、flac、wav、ogg、opus、m4a、webm。流程為檔案／容量檢查 → 串流複製及 SHA-256 → metadata 辨識 → 私有檔案改名 → Prisma 建檔。原始檔保留，同雜湊不重複匯入；失敗清理暫存並且不產生可見曲目。

上傳也以串流寫入暫存，不將整首音檔放進 RAM。每個 API 程序同時只允許一筆上傳／匯入；磁碟應預留最多兩倍單檔大小及 MIN_FREE_BYTES。格式與 metadata 檢查不包含整首解碼驗證。

停用拒絕新播放請求，保留音檔且不打斷既有串流。尚無實體刪除 CLI。匯入使用 `.import-lock`；異常退出時，確認沒有匯入工作後再清理殘留鎖及 `.part`。

## API

搜尋、播放及清單管理使用 `Authorization: Bearer <API_TOKEN>`；上傳使用 `Authorization: Bearer <ADMIN_TOKEN>`。回傳 JSON 使用 camelCase，不包含私有 fileKey／磁碟路徑。

| API | 用途 |
| --- | --- |
| GET /health | DB 與歌曲表可用時 200，否則 503 |
| POST /v1/songs | multipart 音檔上傳，使用 ADMIN_TOKEN |
| GET /v1/songs?query=&cursor=&limit=25 | 標題／演出者部分搜尋；items 與 nextCursor，limit 為 1–25 |
| GET /v1/songs/:id | 標題、演出者、時長、MIME、大小、SHA-256、更新時間 |
| GET /v1/songs/:id/audio | 驗證曲目與檔案後，由 Nginx 傳送音檔 |
| HEAD /v1/songs/:id/audio | 取得完整 Content-Length，仍須授權 |

POST 欄位：`file` 必填，`title`／`artist` 選填，各最多 500 字元。

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -F 'file=@song.mp3' -F 'title=歌曲名稱' -F 'artist=演出者' \
  https://music.example.com/v1/songs
```

新增回傳 201：`{status:"imported",id,song}`；重複檔案回傳 200：`{status:"duplicate",id,song}`，不覆寫既有資料或停用狀態。錯誤包含 401 金鑰、400 無效音訊／欄位、413 超限、415 格式、409 正在上傳／匯入、507 空間／配額不足。

Nginx 支援單一 Range，`/protected-audio/` 為 internal。SQLite 使用 WAL、單一連線與有界快取；一般索引不保證加速任意中文子字串搜尋。

## Discord Bot 整合與個人播放清單

`Cirno_Discord_Bot` 可使用本服務作為遠端曲庫，並將遠端與 Bot 主機的本地歌曲放進同一播放佇列或個人播放清單。在 **Bot 的** `.env` 設定：

```dotenv
REMOTE_MUSIC_API_URL=https://music.example.com/
REMOTE_MUSIC_API_TOKEN=your_music_server_api_token
REMOTE_MUSIC_MODE=stream
REMOTE_MUSIC_BUFFER_SECONDS=3
```

`REMOTE_MUSIC_API_URL` 必須是可以串流音檔的 **Nginx 入口**。使用本機 Docker Compose 的預設 HTTP 埠時，同一主機的 Bot 可使用 `http://127.0.0.1/`；若已調整主機發布埠，須一起調整網址。不同主機的 Bot 請使用可連通的 HTTPS 網址。直接連 Fastify 的 `3000` 埠只能取得 `X-Accel-Redirect`，無法播放音檔。

歌曲與個人清單共用 `REMOTE_MUSIC_API_URL`、`REMOTE_MUSIC_API_TOKEN`；Token 使用目前部署模式的 `API_TOKEN`，上傳管理使用另外的 `ADMIN_TOKEN`。Docker 模式的金鑰在根目錄 `.env`，本機 API 模式則在 `api/.env`；兩份既有設定不會自動同步。請透過安全的環境設定將金鑰提供給 Bot，不要提交金鑰到 Git。

Bot 端的常用操作：

| 指令 | 用途 |
| --- | --- |
| `/music library source:remote` | 瀏覽本服務的曲庫 |
| `/music play source:remote song:歌曲` | 播放遠端歌曲或加入共用佇列 |
| `/playlist create name:通勤` | 建立自己的清單 |
| `/playlist add playlist:通勤 source:remote song:歌曲` | 收藏遠端曲目；也可選本地來源 |
| `/playlist add-current playlist:通勤` | 收藏 Bot 目前播放的曲目 |
| `/playlist play playlist:通勤 shuffle:true` | 將清單加入播放，可選隨機順序 |

每個 Discord 使用者可在 Bot 管理多份清單，包含改名、刪除、增刪歌曲及排序。Bot 的清單管理回覆僅本人可見；播放加入所在伺服器的共用佇列。播放控制、音量、循環及指定秒數跳轉對本地與遠端歌曲共用，完整指令及上限以 Bot 的 README 為準。需部署包含 `/playlist` 的 Bot 版本並重新啟動，全球指令同步可能需要等候 Discord。

**清單服務驗證**

清單 API 與歌曲 API 共用 Server 的 `API_TOKEN`，不需另外啟用或產生清單金鑰。Bot 只需設定 `REMOTE_MUSIC_API_URL` 和 `REMOTE_MUSIC_API_TOKEN`；所有清單管理透過同一個 Server API，清單一律由 Server SQLite 儲存。

每個清單 API 請求使用 `Authorization: Bearer <API_TOKEN>` 與 `X-Discord-User-Id`。Bot 必須從 Discord interaction 的 `user.id` 取得身分，不可接受使用者自行輸入他人的 ID。Server 驗證 API 金鑰後，以該使用者 ID 限定所有查詢及修改。此金鑰授權受信任的 Bot 讀取歌曲及管理使用者清單，請保存在服務端，不要交給 Discord 使用者或放入瀏覽器；跨主機連線請使用 HTTPS。上傳仍需獨立的 `ADMIN_TOKEN`。

舊的 `PLAYLIST_API_URL`、`PLAYLIST_API_TOKEN` 和 `PLAYLIST_BOT_TOKEN` 已停用，可從環境設定移除。既有 `API_TOKEN` 與資料庫沿用，升級不需更換金鑰或搬移清單。

**資料保存與曲目異動**

- 本服務保存遠端音檔、曲目索引及所有個人清單。清單存於 SQLite 的 `playlists`／`playlist_entries`，需持久掛載並備份目前部署模式的 DB 目錄。清單以 Discord 使用者 ID 歸屬，每人最多 20 份、每份 100 首。刪除清單只刪收藏項目，不刪音檔或歌曲資料。
- Bot 必須完整設定共用 API 網址與金鑰才能使用清單功能；設定缺少、不完整或服務故障時會回報錯誤。所有清單操作都經由 API 存取資料庫。
- Bot 的清單保存遠端曲目 ID 與 API 網址，播放前重新查詢歌曲。停用或移除曲目後，Bot 會略過無法取得的歌曲並回報，原收藏仍保留；全部無法取得時不開始播放。
- 更換本服務的對外 API 網址後，需在 Bot 重新加入受影響的遠端收藏；還原本服務資料時請保留曲目 ID。
- `stream` 模式邊接收邊播放；指定秒數跳轉需重新讀取並解碼到目標位置，受 Bot 載入逾時限制。慢速網路可選 `download`，先下載並驗證大小及 SHA-256 後播放。

整合檢查請先完成本文件的 `test:smoke`，確認 Nginx 的授權、HEAD、Range 與音檔串流正常，再於 Discord 使用遠端選歌與清單播放。只有 `/health` 成功不代表音檔串流已就緒。

## 播放清單 API 與升級

下列介面皆需 `API_TOKEN` 及 `X-Discord-User-Id`（17–20 位數的 Discord ID）。其他使用者的清單／項目回傳 404；驗證失敗為 401，格式錯誤為 400，容量、重複名稱與過期版本為 409。所有寫入在 SQLite transaction 內執行，讀寫結果都有 `Cache-Control: no-store`。

| 方法與路徑 | 請求／結果 |
| --- | --- |
| `GET /v1/playlists` | `{items: Playlist[]}`，只回傳該使用者的清單 |
| `POST /v1/playlists` | `{name, tracks?: Track[]}`，201 回傳新清單 |
| `GET /v1/playlists/:id` | 讀取自己的完整清單 |
| `PATCH /v1/playlists/:id` | `{name, revision}`，重新命名 |
| `DELETE /v1/playlists/:id` | `{revision}`，204 無內容 |
| `POST /v1/playlists/:id/entries` | `{tracks, revision}`，整批加入歌曲 |
| `PATCH /v1/playlists/:id/entries/:entryId` | `{position, revision}`，移到從 1 起算的位置 |
| `DELETE /v1/playlists/:id/entries/:entryId` | `{revision}`，移除指定項目 |

`Playlist` 包含 `id`、`ownerId`、`name`、`revision`、依序排列的 `entries`。`Track` 包含 `source: local|remote`、`id`、`title`、選用 `artist`；遠端曲目另須 `library`（原 API 網址）。`entries` 比 `Track` 多出獨立的 UUID `entryId`，因此重複收藏同一歌曲仍可分別排序及移除。標題／演出者最多 500 字，清單名稱正規化後為 1–60 字；同一使用者不可使用重複名稱。新增清單／加入歌曲請求上限 512 KiB，不接受音檔、磁碟路徑或金鑰作為收藏資料。

修改前請先讀取清單，提交回傳的 `revision`。版本過期時整個 transaction 會回滾，請重新讀取後由使用者確認操作，勿自動覆蓋。

升級步驟：

1. 備份現有 SQLite；暫停 Bot 的清單寫入。
2. 更新 Server 並執行 `bash scripts/setup.sh`。本機從 `api/` 執行 `npm ci && npm run db:generate && npm run db:migrate && npm run build` 並重新啟動 Server；Docker 執行 `docker compose up -d --build`，啟動時自動套用 migration，保留既有歌曲與清單。移除清單匯入功能的 migration 僅刪除已停用的匯入摘要欄位，不刪除清單或歌曲。
3. Bot 沿用 `REMOTE_MUSIC_API_URL`、`REMOTE_MUSIC_API_TOKEN`（Server 的 `API_TOKEN`），更新並建置 Bot；舊的清單專用設定可移除。
4. 重新啟動 Bot，驗證 `/playlist list`、新增、排序及播放；跨主機部署須確認 Nginx 入口可用。

若 Prisma 回報空白的 `Schema engine error`，請檢查執行環境是否帶入了限制過嚴的 `RUST_LOG`；可使用 `RUST_LOG=info npm run db:migrate`。Prisma CLI 與 Client 固定使用 6.19.3。

`npm test` 會在暫存 SQLite 驗證原歌曲 API 與清單權限、CRUD、容量、版本競態、持久化。兩個專案完成建置後，可在 Bot 根目錄執行 `node scripts/test-playlist-server.mjs ../music_server/api`，以真實 HTTP 與 SQLite 驗證跨專案流程，不會修改正式資料。

## 環境變數

Docker 部署修改根目錄 `.env`；Linux 本機 API 修改 `api/.env`。`scripts/setup.sh` 會建立缺少的檔案與隨機金鑰，既有的兩份設定不會自動同步。以下是範例設定值；金鑰請使用腳本產生的值。

| 設定 | 範例／預設值 | 用途 |
| --- | --- | --- |
| `API_TOKEN` | 腳本產生的 64 字元隨機金鑰 | 搜尋、查詢、播放及個人清單管理授權；至少 32 字元，必須替換範例占位文字 |
| `ADMIN_TOKEN` | 另一組隨機金鑰 | 上傳授權；至少 32 字元且須與 API_TOKEN 不同，留空會停用上傳 |
| `MAX_AUDIO_BYTES` | `268435456`（256 MiB） | 每首音檔大小上限；HTTP 上傳即使設更大仍限制為 256 MiB，CLI 匯入使用設定值 |
| `MIN_FREE_BYTES` | `536870912`（512 MiB） | 上傳／匯入時要求保留的磁碟空間 |
| `LIBRARY_QUOTA_BYTES` | `10737418240`（10 GiB） | 曲庫容量上限，包含停用曲目 |

容量設定單位為 bytes，必須是大於 0 的安全整數；`0` 不代表無上限。

**根目錄 `.env`：Docker 與 Nginx 設定**

| 設定 | 預設值 | 用途 |
| --- | --- | --- |
| `SERVER_NAME` | 留空 | 留空使用本地 IP 的 HTTP；例如 `music.example.com` 啟用網域 HTTP 與自動 HTTPS，不填協定或連接埠 |
| `NGINX_BIND` | `0.0.0.0` | 主機上綁定 80／443 的 IP；`0.0.0.0` 代表所有 IPv4 介面，也可指定主機實際 IP |
| `MUSIC_API_IMAGE` | `remote-music-api:local` | API 映像檔名稱；部署指令會在主機建置此映像檔 |
| `MUSIC_DATA_ROOT` | `./data/container` | Docker 掛載的主機資料根目錄，底下包含 db／audio／inbox；更改路徑不會自動搬移既有資料 |
| `API_UPSTREAM` | `api:3000` | Nginx 轉發的 API 位址；完整 Docker 部署保留預設，本機 API 搭配 Docker Nginx 使用 `host.docker.internal:3000` |

Docker 容器內的 Nginx 固定監聽 `0.0.0.0`；`NGINX_BIND` 控制的是主機發布連接埠的位址。本機 Nginx 的綁定位址直接修改 conf 裡的 `listen`，例如 `listen 10.0.0.86:80;`。

**`api/.env`：Linux 本機 API 設定**

| 設定 | 範例設定值 | 用途 |
| --- | --- | --- |
| `DATABASE_URL` | `file:../../data/db/songs.db?connection_limit=1&socket_timeout=5` | SQLite 位址，file 相對路徑以 `api/prisma/schema.prisma` 所在目錄為基準 |
| `AUDIO_DIRECTORY` | `../data/audio` | 保存音檔的目錄，相對於 API 指令的工作目錄 |
| `IMPORT_DIRECTORY` | `../data/inbox` | CLI 匯入掃描的目錄，相對於 API 指令的工作目錄 |
| `HOST` | `127.0.0.1` | API 監聽位址；搭配 Docker Nginx 時使用 `0.0.0.0`；API 連接埠固定為 3000 |
| `LOG_LEVEL` | `info` | API 日誌等級，例如 `debug`、`info`、`warn`、`error` |

本機指令請從 `api/` 執行。Docker API 的 DB、音檔與 inbox 路徑分別固定為 `/srv/music-db/songs.db`、`/srv/music-audio`、`/srv/music-inbox`，HOST 固定為 `0.0.0.0`、LOG_LEVEL 為 `info`；修改 `api/.env` 不影響 Docker 部署。

修改根目錄 `.env` 後，在根目錄執行 `docker compose up -d` 套用設定；只執行 `restart` 不會更新容器環境變數。本機 API 修改設定後，停止並重新執行 `npm run dev`。本機 Nginx 直接修改 `/etc/nginx/conf.d/music.conf`，檢查設定後重新載入；不讀取 `.env`。

Docker 與本機預設使用不同資料目錄，避免同時寫入同一個 SQLite。`.env` 包含金鑰，請勿提交到 Git。


## 程式架構

前後端模組邊界、transaction、資源所有權與驗證方式見 [架構說明](docs/architecture.md)。
