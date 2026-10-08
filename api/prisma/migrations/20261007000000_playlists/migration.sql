CREATE TABLE "playlists" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "import_hash" TEXT
);
CREATE UNIQUE INDEX "playlists_owner_id_name_key_key" ON "playlists"("owner_id", "name_key");
CREATE TABLE "playlist_entries" (
    "entry_id" TEXT NOT NULL PRIMARY KEY,
    "playlist_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "track_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "library" TEXT,
    CONSTRAINT "playlist_entries_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "playlist_entries_playlist_id_position_idx" ON "playlist_entries"("playlist_id", "position");
