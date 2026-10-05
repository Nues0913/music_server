import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const fileKeyPattern = /^[0-9a-f-]{36}\.(mp3|flac|wav|ogg|opus|m4a|webm)$/;

export async function resolveAudio(root: string, fileKey: string): Promise<string> {
  if (!fileKeyPattern.test(fileKey)) throw new Error('Invalid audio key');
  const base = await realpath(root);
  const candidate = join(base, fileKey);
  const entry = await lstat(candidate);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Not a regular audio file');
  const resolved = await realpath(candidate);
  if (dirname(resolved) !== base) throw new Error('Audio outside library');
  return resolved;
}

