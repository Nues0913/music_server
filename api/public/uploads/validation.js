const extensions = /\.(mp3|flac|wav|ogg|opus|m4a|webm)$/i;
export function fileError(file, maxBytes) {
  if (!file) return '請選擇符合格式與大小限制的音檔。';
  if (!extensions.test(file.name)) return '不支援此格式，請選擇音訊檔案。';
  if (!file.size || file.size > maxBytes) return '音檔為空或超過大小上限。';
  return undefined;
}
