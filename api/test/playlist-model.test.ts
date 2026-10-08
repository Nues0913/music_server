import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntries, moveEntry, normalizeName, presentPlaylist, PlaylistError } from '../src/modules/playlists/model.js';

test('playlist rules normalize names and reject invalid remote references before persistence', () => {
  assert.deepEqual(normalizeName(' Ｍｉｘ '), { name: 'Mix', nameKey: 'mix' });
  assert.throws(() => normalizeName('\n'), PlaylistError);
  assert.throws(() => createEntries([{ source: 'remote', id: 'not-uuid', title: 'song', library: 'https://music.example/' }]), PlaylistError);
  assert.throws(() => createEntries([{ source: 'local', id: 'song', title: 'song', library: 'https://token:secret@music.example/' }]), PlaylistError);
});
test('reordering leaves the original snapshot intact and presentation excludes persistence fields', () => {
  const entries = createEntries([{ source: 'local', id: 'song-a', title: 'A' }, { source: 'local', id: 'song-a', title: 'A' }]);
  assert.notEqual(entries[0].entryId, entries[1].entryId);
  const moved = moveEntry(entries, entries[1].entryId, 1);
  assert.equal(moved[0].entryId, entries[1].entryId); assert.equal(entries[0].position, 0);
  assert.throws(() => moveEntry(entries, 'missing', 1), PlaylistError);
  const dto = presentPlaylist({ id: 'id', ownerId: 'owner', name: 'list', nameKey: 'list', revision: 3,
    entries: entries.map(entry => ({ ...entry, playlistId: 'id', artist: null, library: null })) });
  assert.equal(dto.revision, 3); assert.equal('nameKey' in dto, false); assert.equal('playlistId' in dto.entries[0], false);
});
