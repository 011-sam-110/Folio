// Network calls for the lecture import, kept in this feature rather than added to lib/api.ts.
//
// The serverless deployment caps a request body at ~4.5MB and a function at 60s, so the video
// itself is never sent — only the derived slide JPEGs (~100-250KB each) and the caption text.
// Slides go up one per request against the existing single-image endpoint, a few at a time:
// that keeps every request far inside the body cap and stops a 40-slide lecture from opening
// 40 simultaneous sockets.

import { ApiError } from '../../../lib/api';
import type { Note } from '../../../lib/types';
import type { SlideImage } from './extractSlides';
import type { UploadedSlide } from './buildNote';

/** Hard ceiling per request; well above a normal slide JPEG, and below the platform's ~4.5MB. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Concurrent uploads. Enough to hide latency, few enough to stay polite. */
const UPLOAD_CONCURRENCY = 3;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new ApiError(detail?.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** Re-encodes a slide smaller until it fits the request cap. */
async function fitToLimit(blob: Blob, width: number, height: number): Promise<Blob> {
  if (blob.size <= MAX_UPLOAD_BYTES) return blob;
  let current = blob;
  let scale = 1;
  for (let attempt = 0; attempt < 4 && current.size > MAX_UPLOAD_BYTES; attempt++) {
    scale *= 0.7;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const next = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.6));
      if (!next) break;
      current = next;
    } finally {
      bitmap.close();
    }
  }
  if (current.size > MAX_UPLOAD_BYTES) {
    throw new Error('A slide image is too large to upload even after compression');
  }
  return current;
}

async function uploadOne(slide: SlideImage, index: number): Promise<UploadedSlide> {
  const blob = await fitToLimit(slide.blob, slide.width, slide.height);
  const form = new FormData();
  form.append('file', new File([blob], `slide-${String(index + 1).padStart(3, '0')}.jpg`, { type: 'image/jpeg' }));
  const res = await fetch('/api/import/image', { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new ApiError(detail?.error ?? `Slide upload failed (${res.status})`, res.status);
  }
  const { url } = (await res.json()) as { url: string };
  return { slide, url };
}

/**
 * Uploads every slide, preserving order, with bounded concurrency.
 *
 * @param onProgress called with the count finished so far.
 */
export async function uploadSlides(
  slides: SlideImage[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<UploadedSlide[]> {
  const results = new Array<UploadedSlide | undefined>(slides.length);
  let cursor = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const i = cursor++;
      if (i >= slides.length) return;
      results[i] = await uploadOne(slides[i], i);
      done++;
      onProgress?.(done, slides.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, slides.length) }, () => worker()),
  );
  return results.filter((r): r is UploadedSlide => r !== undefined);
}

export function createLectureNote(body: {
  notebookId: string;
  title: string;
  contentJson: unknown;
  contentText: string;
}): Promise<{ note: Note }> {
  return postJson<{ note: Note }>('/api/notes', body);
}
