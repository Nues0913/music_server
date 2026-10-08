import { InvalidAudioError, CapacityError } from '../../storage/errors.js';

export class UploadError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) { super(message); }
}
export function uploadFailure(error: unknown) {
  if (error instanceof UploadError) return { status: error.status, error: error.message, retryAfter: error.retryAfter };
  const failure: Error & { code?: string } = error instanceof Error ? error : new Error(String(error));
  if (failure.code === 'FST_REQ_FILE_TOO_LARGE') return { status: 413, error: '音檔超過大小上限' };
  if (failure.code?.startsWith('FST_') && /PARTS_LIMIT|FILES_LIMIT|FIELDS_LIMIT|MULTIPART/.test(failure.code)) return { status: 400, error: '上傳格式或欄位不正確' };
  if (failure.code === 'EEXIST') return { status: 409, error: '曲庫正在匯入，請稍後再試' };
  if (failure.code === 'ENOSPC' || failure instanceof CapacityError) return { status: 507, error: '磁碟空間或曲庫配額不足' };
  if (failure instanceof InvalidAudioError) return { status: 400, error: '無法匯入音檔，請確認檔案完整且為有效音訊' };
  return { status: 503, error: '服務暫時無法匯入音檔，請稍後再試', unexpected: true };
}
