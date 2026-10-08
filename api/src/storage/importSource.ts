import { lstat, realpath } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { audioMimeType } from './formats.js';
import { InvalidAudioError } from './errors.js';

export async function inspectImportSource(inbox: string, source: string, maxBytes: number) {
  const inputRoot = await realpath(inbox);
  const candidate = resolve(source);
  if (dirname(candidate) !== inputRoot) throw new InvalidAudioError('Import only first-level inbox files');
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new InvalidAudioError('Input must be a regular file, not a symlink');
  if (dirname(await realpath(candidate)) !== inputRoot) throw new InvalidAudioError('Input outside inbox');
  const mimeType = audioMimeType(candidate);
  if (!mimeType) throw new InvalidAudioError('Unsupported audio extension');
  if (!info.size || info.size > maxBytes) throw new InvalidAudioError('Invalid audio file size');
  return { path: candidate, size: info.size, extension: extname(candidate).toLowerCase(), mimeType };
}
