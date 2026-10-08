import { basename, extname } from 'node:path';
import { parseFile } from 'music-metadata';

export interface ImportLabels { originalName?: string; title?: string; artist?: string; }
export async function readSongMetadata(path: string, originalPath: string, labels: ImportLabels) {
  const metadata = await parseFile(path, { duration: true, skipCovers: true });
  if (!metadata.format.codec || !metadata.format.numberOfChannels) throw new Error('No recognized audio stream');
  const duration = metadata.format.duration;
  const originalName = labels.originalName ?? originalPath;
  return {
    title: (labels.title?.trim() || metadata.common.title?.trim() || basename(originalName, extname(originalName))).slice(0, 500),
    artist: (labels.artist?.trim() || metadata.common.artist?.trim())?.slice(0, 500) || null,
    durationSeconds: duration && Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}
