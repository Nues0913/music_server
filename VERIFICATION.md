# 本機驗證紀錄

日期：2026-10-05。所有專案檔案位於目前根目錄；參考用前端源碼未修改。

| 環境 | 版本 |
| --- | --- |
| Windows Node.js／npm | 24.19.0／11.17.0 |
| Docker Desktop／Engine | 4.94.0／29.8.2 |
| Docker Compose | 5.5.1 |
| Linux runtime | Node.js 22 Alpine，linux/amd64 |
| Fastify／Prisma | 5.12.5／6.19.3 |

已通過：

- 本機 Prisma generate、db push 與 TypeScript 編譯。
- 8 組真實 SQLite 整合測試：原有搜尋／匯入回歸，加上管理者上傳權限、metadata、去重、超限／非法欄位／檔案清理，以及真實 HTTP 中斷後釋放上傳名額。
- Windows API + Docker Nginx：授權、中文搜尋、完整音檔 SHA-256、HEAD、Range 206、禁止直接存取私有目錄、兩路並行串流。
- Linux 多階段建置：容器內安裝依賴、生成 Prisma native 引擎、編譯；未複製 Windows node_modules。
- 完整 Compose：migration、健康檢查、CLI 匯入與上述 HTTP smoke test。
- API 容器重建後資料仍存在、migration 可重複執行；再次匯入同檔回傳 duplicate 與相同歌曲 ID。

初次完整容器啟動、migration、匯入與 smoke test 後的記憶體快照：

| 指標 | API | Nginx |
| --- | --- | --- |
| docker stats 用量 | 85.62 MiB | 3.281 MiB |
| cgroup memory.current | 148,430,848 bytes | 7,983,104 bytes |
| cgroup memory.peak | 202,014,720 bytes | 8,482,816 bytes |
| RAM 上限 | 256 MiB | 48 MiB |
| OOM／oom_kill／restart | 0／0／0 | 0／0／0 |

docker stats 與 cgroup 記憶體的統計口徑不同，不可直接混用；cgroup 包含計費至容器的快取。兩個獨立峰值加總約 200.75 MiB，不代表同一瞬間用量，也不包含 Windows、Docker Desktop 或 Oracle 宿主機。

測試使用 2 秒合成 WAV，涵蓋功能與短串流；尚未測試大量曲庫、長音檔／10 分鐘暫停、Oracle 冷啟動與整機 500 MB、HTTPS、Discord 語音或自動備份還原。容器建置的 TypeScript 在 128 MiB heap 失敗，改為建置階段 256 MiB heap 後通過；執行階段仍為 128 MiB heap、256 MiB 容器上限。

重新驗證：在 api/ 執行 `npm.cmd run build`、`npm.cmd test`；啟動對應部署並匯入合成 WAV 後執行 `npm.cmd run test:smoke`。操作順序與兩種模式切換見 README。

## 上傳功能追加驗證

- Windows API + Nginx 與完整 Linux Compose 均通過 Edge headless 網頁上傳：一般播放 token 被拒絕，管理 token 成功，歌名／演出者保存，金鑰清除，無 localStorage，桌面／390px 手機無水平溢出。
- 完整 Compose 通過 16 MiB 合成 WAV 的流式 POST、資料庫大小／SHA-256 驗證，並通過原有播放、HEAD／Range 回歸。新檔會在測試曲庫保留。
- 這輪 API cgroup memory.current 為 59,916,288 bytes、memory.peak 為 102,821,888 bytes；Nginx 為 8,839,168／12,849,152 bytes。兩個峰值獨立量測，這輪使用已建立的容器 DB，不等同前次首次 migration／CLI 匯入的峰值。
- OOM、oom_kill、容器重啟均為 0；成功上傳後 .uploads 無子目錄殘留。
- 管理頁截圖：data/verification/upload-desktop.png、upload-mobile.png。瀏覽器測試為 `npm.cmd run test:browser`，16 MiB 串流測試為 `npm.cmd run test:upload`。

仍未驗證 256 MiB 上限檔案與 Oracle 整機負载，不能據此保證整機低於 500 MB。
