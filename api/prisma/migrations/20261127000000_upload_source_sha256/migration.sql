ALTER TABLE "songs" ADD COLUMN "upload_source_sha256" TEXT;
CREATE UNIQUE INDEX "songs_upload_source_sha256_key" ON "songs"("upload_source_sha256");
