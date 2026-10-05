-- CreateTable
CREATE TABLE "songs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "file_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "duration_seconds" REAL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "songs_file_key_key" ON "songs"("file_key");

-- CreateIndex
CREATE UNIQUE INDEX "songs_sha256_key" ON "songs"("sha256");

-- CreateIndex
CREATE INDEX "songs_status_id_idx" ON "songs"("status", "id");

-- CreateIndex
CREATE INDEX "songs_title_idx" ON "songs"("title");

-- CreateIndex
CREATE INDEX "songs_artist_idx" ON "songs"("artist");
