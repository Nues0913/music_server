-- Remove obsolete playlist-import metadata while retaining playlists and entries.
ALTER TABLE "playlists" DROP COLUMN "import_hash";
