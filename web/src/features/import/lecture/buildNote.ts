// Assembles the imported lecture into a TipTap document.
//
// Shape per slide: a heading with its timestamp, the slide image, then whatever was said while
// that slide was on screen. Aligning captions to slides is the point of the whole feature -
// a wall of transcript under a pile of images would be no more useful than the raw recording.

import type { SlideImage } from './extractSlides';
import type { TranscriptChunk } from './transcribeWorker';

export interface UploadedSlide {
  slide: SlideImage;
  url: string;
}

export interface TipTapDoc {
  type: 'doc';
  content: unknown[];
}

export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Captions belonging to a slide's time range.
 *
 * A slide's range runs from when it appeared until the next slide appeared, so a caption is
 * assigned by where it STARTS. Using overlap instead would duplicate any sentence spanning a
 * slide change into both slides.
 */
export function captionsForRange(chunks: TranscriptChunk[], start: number, end: number): TranscriptChunk[] {
  return chunks.filter(c => c.start >= start && c.start < end);
}

function paragraph(text: string): unknown {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

function joinChunks(chunks: TranscriptChunk[]): string {
  return chunks
    .map(c => c.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BuildNoteInput {
  slides: UploadedSlide[];
  chunks: TranscriptChunk[];
  /** Total video duration, so the last slide's caption range has an end. */
  durationSeconds: number;
  sourceName: string;
  includeTranscript: boolean;
}

export interface BuiltNote {
  doc: TipTapDoc;
  text: string;
}

export function buildLectureNote({
  slides,
  chunks,
  durationSeconds,
  sourceName,
  includeTranscript,
}: BuildNoteInput): BuiltNote {
  const content: unknown[] = [];
  const textParts: string[] = [];

  content.push({
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'italic' }], text: `Imported from ${sourceName}` }],
  });
  textParts.push(`Imported from ${sourceName}`);

  // Captions that precede the first slide would otherwise be silently dropped.
  if (includeTranscript && slides.length > 0) {
    const preamble = joinChunks(captionsForRange(chunks, 0, slides[0].slide.startTime));
    if (preamble) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Before the first slide' }] });
      content.push(paragraph(preamble));
      textParts.push('Before the first slide', preamble);
    }
  }

  slides.forEach((entry, i) => {
    const { slide, url } = entry;
    const next = slides[i + 1];
    const rangeEnd = next ? next.slide.startTime : durationSeconds;
    const stamp = formatTimestamp(slide.startTime);
    const heading = `Slide ${i + 1} (${stamp})`;

    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] });
    content.push({ type: 'image', attrs: { src: url, alt: `Slide ${i + 1} at ${stamp}`, title: null } });
    textParts.push(heading);

    if (includeTranscript) {
      const said = joinChunks(captionsForRange(chunks, slide.startTime, rangeEnd));
      if (said) {
        content.push(paragraph(said));
        textParts.push(said);
      }
    }
  });

  if (slides.length === 0 && includeTranscript) {
    // No slides detected (a talking-head recording, say) - the transcript is still worth having.
    const all = joinChunks(chunks);
    if (all) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Transcript' }] });
      content.push(paragraph(all));
      textParts.push('Transcript', all);
    }
  }

  if (content.length === 0) content.push(paragraph(''));

  return { doc: { type: 'doc', content }, text: textParts.join('\n\n') };
}

/** "DSA Lecture 18 (Paths problems_ BFS)_default_0ccb797d.mp4" -> "DSA Lecture 18 (Paths problems BFS)" */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return (
    base
      // Lecture-capture exports tail their filenames with a profile and a content hash.
      .replace(/_default_[0-9a-f]{6,}$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Lecture'
  );
}
