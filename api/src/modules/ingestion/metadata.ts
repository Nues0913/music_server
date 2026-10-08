import { basename, extname } from 'node:path';
import { parseFile, CouldNotDetermineFileTypeError, UnsupportedFileTypeError, UnexpectedFileContentError, FieldDecodingError } from 'music-metadata';
import { InvalidAudioError } from '../../storage/errors.js';

export interface ImportLabels { originalName?: string; title?: string; artist?: string; }
export async function readSongMetadata(path: string, originalPath: string, labels: ImportLabels) {
  const metadata = await parseFile(path, { duration: true, skipCovers: true }).catch(error => {
    // Node I/O errors must not be reported as a user's damaged audio file.
    if (error instanceof CouldNotDetermineFileTypeError || error instanceof UnsupportedFileTypeError ||
      error instanceof UnexpectedFileContentError || error instanceof FieldDecodingError || error?.name === 'EndOfStreamError') {
      throw new InvalidAudioError('Unrecognized or damaged audio stream', { cause: error });
    }
    throw error;
  });
  if (!metadata.format.codec || !metadata.format.numberOfChannels) throw new InvalidAudioError('No recognized audio stream');
  const duration = metadata.format.duration;
  const originalName = labels.originalName ?? originalPath;
  return {
    title: (labels.title?.trim() || metadata.common.title?.trim() || basename(originalName, extname(originalName))).slice(0, 500),
    artist: (labels.artist?.trim() || metadata.common.artist?.trim())?.slice(0, 500) || null,
    durationSeconds: duration && Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}
