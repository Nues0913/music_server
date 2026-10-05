import 'dotenv/config';

export function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

export function apiToken(): string {
  const value = process.env.API_TOKEN ?? '';
  if (value.length < 32 || value.startsWith('replace-with-')) {
    throw new Error('API_TOKEN must contain at least 32 characters; configure .env');
  }
  return value;
}

export const audioDirectory = () => process.env.AUDIO_DIRECTORY ?? '/srv/music-audio';
export const importDirectory = () => process.env.IMPORT_DIRECTORY ?? '/srv/music-inbox';

export function adminToken(): string | undefined {
  const value = process.env.ADMIN_TOKEN;
  if (!value) return undefined;
  if (value.length < 32 || value.startsWith('replace-with-') || value === process.env.API_TOKEN) {
    throw new Error('ADMIN_TOKEN must be distinct from API_TOKEN and contain at least 32 characters');
  }
  return value;
}

