// Client-side photo downscale before upload — phones send 12MP+ JPEG/HEIC,
// we only need enough resolution for vision OCR. Best-effort: any failure
// (unsupported format like HEIC in some browsers, canvas errors, etc.) just
// falls back to uploading the original file untouched.

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export async function downscaleImage(file: File, maxEdge = MAX_EDGE, quality = JPEG_QUALITY): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = bitmap;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      if (scale >= 1) {
        return file;
      }
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return file;
      const name = `${file.name.replace(/\.[^./\\]+$/, '')}.jpg`;
      return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}
