import { extname } from 'node:path';
export const audioMimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.webm': 'audio/webm',
};
export const audioMimeType = (filename: string) => audioMimeTypes[extname(filename).toLowerCase()];
