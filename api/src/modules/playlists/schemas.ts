import { boundedString, idParams, objectSchema, uuidPattern } from '../../shared/http/schemas.js';
import { maxPlaylistRevision, playlistLimits } from './model.js';
export { idParams };
export const revisionSchema = { type: 'integer', minimum: 1, maximum: maxPlaylistRevision };
const trackSchema = objectSchema({ source: { enum: ['local', 'remote'] }, id: boundedString(128),
  title: boundedString(500), artist: boundedString(500), library: boundedString(2048) }, ['source', 'id', 'title']);
const tracksSchema = { type: 'array', maxItems: playlistLimits.entries, items: trackSchema };
export const entryParams = objectSchema({ id: { type: 'string', pattern: uuidPattern }, entryId: { type: 'string', pattern: uuidPattern } });
export const createSchema = objectSchema({ name: boundedString(playlistLimits.name), tracks: tracksSchema }, ['name']);
export const renameSchema = objectSchema({ name: boundedString(playlistLimits.name), revision: revisionSchema });
export const deleteSchema = objectSchema({ revision: revisionSchema });
export const addSchema = objectSchema({ tracks: { ...tracksSchema, minItems: 1 }, revision: revisionSchema });
export const moveSchema = objectSchema({ revision: revisionSchema, position: { type: 'integer', minimum: 1, maximum: playlistLimits.entries } });
