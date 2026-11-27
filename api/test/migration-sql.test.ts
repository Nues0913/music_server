import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('SQLite migration retains IDs, child references, revisions and cascade while removing import metadata', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of ['20261006030000_init', '20261007000000_playlists']) {
      db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    }
    db.prepare('INSERT INTO playlists(id,owner_id,name,name_key,revision,import_hash) VALUES(?,?,?,?,?,?)')
      .run('playlist-id', '123456789012345678', 'existing', 'existing', 9, 'obsolete');
    db.prepare('INSERT INTO playlist_entries(entry_id,playlist_id,position,source,track_id,title) VALUES(?,?,?,?,?,?)')
      .run('entry-id', 'playlist-id', 0, 'local', 'song-id', 'existing song');
    db.exec(readFileSync('prisma/migrations/20261008000000_remove_playlist_import/migration.sql', 'utf8'));
    const row = db.prepare('SELECT id,owner_id,revision FROM playlists').get();
    assert.deepEqual({ ...row }, { id: 'playlist-id', owner_id: '123456789012345678', revision: 9 });
    assert.equal(db.prepare('SELECT entry_id FROM playlist_entries').get()?.entry_id, 'entry-id');
    assert.ok(!db.prepare('PRAGMA table_info(playlists)').all().some(column => column.name === 'import_hash'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.prepare('DELETE FROM playlists WHERE id=?').run('playlist-id');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playlist_entries').get()?.count, 0);
  } finally { db.close(); }
});

test('upload fingerprint migration preserves existing songs and allows only unique non-null upload fingerprints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync('prisma/migrations/20261006030000_init/migration.sql', 'utf8'));
    const insert = db.prepare(`INSERT INTO songs(id,file_key,title,mime_type,byte_size,sha256,updated_at)
      VALUES (?, ?, 'Existing song', 'audio/mpeg', 1234, ?, CURRENT_TIMESTAMP)`);
    insert.run('saved-1', 'first.mp3', 'stored-1');
    insert.run('saved-2', 'second.mp3', 'stored-2');
    const original = db.prepare('SELECT * FROM songs ORDER BY id').all();
    db.exec(readFileSync('prisma/migrations/20261127000000_upload_source_sha256/migration.sql', 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM songs ORDER BY id').all().map(row => ({ ...row })),
      original.map(row => ({ ...row, upload_source_sha256: null })));
    const recordSource = db.prepare('UPDATE songs SET upload_source_sha256 = ? WHERE id = ?');
    recordSource.run('source-hash', 'saved-1');
    assert.throws(() => recordSource.run('source-hash', 'saved-2'), /UNIQUE constraint failed/);
  } finally { db.close(); }
});
