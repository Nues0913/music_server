# 音樂服務前後端架構

以 `dev` 的資料與 API 契約為基礎，依 pragmatic-modular-architecture skill 重新劃分責任。維持一個 Fastify API、SQLite 與 Nginx，管理頁使用原生 ES modules；不增加框架、容器或空的 CRUD 抽象層。

```text
api/
  src/
    app.ts                         HTTP 應用組裝與共用錯誤邊界
    server.ts / cli.ts             程序啟動、設定及結束
    config.ts                      已有的環境設定驗證
    infrastructure/database.ts     Prisma 連線與 SQLite 設定
    shared/http/                   Bearer 驗證與共用 schema
    modules/
      songs/                       搜尋、公開 DTO、音檔可用性與路由
      playlists/                   schema、規則、transaction、錯誤及路由
      ingestion/                   metadata 與匯入／發布流程
      uploads/                     multipart、容量、上傳所有權及路由
      admin/                       管理頁及明確允許的靜態資源
    storage/                       路徑、格式、來源檢查、磁碟預算及串流複製
  public/
    app.js                         頁面組裝
    uploads/
      controller.js                上傳狀態、取消、回復與過期事件保護
      client.js                    HTTP／XHR、timeout、response 與進度
      view.js                      DOM、畫面更新與 listener 綁定／移除
      validation.js                檔案格式與大小規則
  prisma/                          原有 schema 及 migrations
  test/                            DB、HTTP、storage、controller 與瀏覽器測試
  scripts/check-architecture.mjs    靜態依賴與循環檢查
```

## 後端邊界

`app.ts` 建立具體 service 並交给 routes；routes 只處理驗證、HTTP schema、參數／狀態碼與錯誤映射。service 管資料查詢、操作流程及 transaction。純粹的清單名稱、歌曲參照、排序與公開資料投影放在 model；型別可由 Prisma 推導，但不在 HTTP／管理頁暴露 ORM 私有欄位。

小型專案直接在 service 使用注入的 Prisma Client，避免增加只轉呼叫 ORM 的 repository。檔案操作有自己的 storage 模組，不能反向引用 HTTP／feature。上傳與 CLI 共用 ingestion，避免兩條流程的 metadata、去重及發布規則分歧。

`SongService` 查資料並驗證檔案存在、路徑及大小，route 只回 `X-Accel-Redirect`。音檔 bytes、HEAD／Range、Content-Length 繼續由 Nginx 負責。

## 清單 transaction 與跨庫契約

同一份清單及其中 entries 共用 revision。rename/add/remove/move 在同一 transaction 內先驗證 owner，再以 `id + ownerId + revision` 的條件更新原子取得版本；受影響筆數為 0 時回 409，不修改 entries。取得版本後若容量、排序、資料驗證或寫入失敗，transaction 連同 revision 增加一起回滾。刪除也以相同 owner/revision 條件刪除，過期確認回 409。

Bot 必須傳它實際讀到的 revision。409 後重新讀取並讓使用者確認，不自動重試覆蓋。專用 Bot 金鑰與 `X-Discord-User-Id` 仍是清單信任邊界，不能從請求 body 接收 ownerId。

本次沒有更動 schema 或 migrations。dev 已移除的清單匯入 API 維持不存在；既有 `remove_playlist_import` migration 只移除 `import_hash`，保留 ID、entries、revision 與外鍵。

## 上傳與資源所有權

`UploadService` 擁有程序內一筆上傳的 slot 與 staging 目錄；finally 清理 staging，即使清理失敗也釋放 slot。`receiveMultipart` 以 pipeline 寫入檔案，限制欄位、大小及磁碟預算，不將音檔全部載入 RAM。

`importFile` 擁有 `.import-lock`、暫存複製與發布流程：檢查來源／容量 → 串流複製及雜湊 → 去重 → metadata → rename → DB 建檔。失敗清理未發布檔案，並在外層 finally 釋放鎖；原有 crash lock 的人工檢查規則保留。DB rollback 無法撤回檔案系統改名，因此檔案發布失敗補償保持明確。

`server.ts` 在關閉 Fastify 時斷開 DB，CLI 在 finally 斷開 DB。程序內 slot 與跨程序 filesystem lock 職責不同，不把記憶體布林值當跨程序鎖。

## 前端邊界

controller 管目前 request、busy、啟用狀態與檔案上限，client 管網路，view 管 DOM。以 request generation 拒絕已完成上傳的晚到進度，dispose 取消請求並忽略晚到結果；一般 pagehide 清理 listeners，瀏覽器保留頁面於 bfcache 時保留可恢復狀態。

成功新增才清除已選檔案；重複歌曲與失敗保留輸入。取消、網路錯誤、HTTP 失敗及 timeout 都釋放 busy。token 僅來自頁面 input，不寫 localStorage/sessionStorage，不放在 URL。靜態資源使用明確清單，保留 CSP、nosniff 與 no-store。

## 驗證與維護

從 `api/` 執行：

```bash
npm ci
npm run db:generate
npm run build
npm run typecheck
npm run check:architecture
npm run test:unit
npm test
```

`test:unit` 不需 Prisma 原生引擎：測管理頁 controller、Chromium 操作、HTTP 契約、清單規則及實際 SQLite migration SQL。Chromium 預設 `/usr/bin/chromium`，可由 BROWSER_PATH 指定；找不到時瀏覽器案例會標記 skip。測試全程使用 fixture／暫存資料，不寫正式曲庫。

`npm test` 另外執行原生 Prisma／SQLite 整合測試：匯入、去重、容量、權限、兩個獨立 Client 的同版本競爭、transaction rollback 與持久化。HTTP contract 測試注入 service，只證明 HTTP 邊界，不能替代這些 DB 測試。正常 generation/build 完成後，Bot 的 `scripts/test-playlist-server.mjs` 驗證真實跨庫 HTTP 與 SQLite。

本次工作環境拒絕 `binaries.prisma.sh` 下載（403）。已用同版本官方 generator 依原 schema 離線產生型別做編譯；該忽略原生引擎的生成結果位於未提交的 node_modules，**不是部署用 Client**。需在可下載引擎的環境正常執行 db:generate，再補跑原生 DB、跨庫整合與 Docker／Nginx 驗證；不將未執行的項目宣稱通過。

架構檢查限制 shared/storage/model 的反向依賴、管理頁 view/client 的依賴方向及静態 runtime 循環。新增功能先放到對應 module，由 app 組裝；需要新的副作用邊界或獨立狀態才抽 service，不機械式增加層級。
