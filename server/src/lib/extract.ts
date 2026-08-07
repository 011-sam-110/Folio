// Turns an uploaded file on disk into raw text for the AI to restructure.
// Supported: PDF (unpdf), PPTX/DOCX (officeparser), TXT/MD (plain read).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractText } from 'unpdf';
import { parseOffice, type OfficeContentNode } from 'officeparser';

export interface ExtractResult {
  text: string;
  /**
   * The same text, still cut where the file cuts it: one entry per page of a PDF, per slide
   * of a .pptx. Absent for formats that have no such structure (docx, txt, md).
   *
   * Returned alongside `text` rather than instead of it because it is what
   * lib/provenance.ts stores so a citation can say "slide 14 of 31" - `text` flattens that
   * away, and the import's AI pass then removes the printed slide numbers too, so this is
   * the last point at which the position is still knowable. Blank pages are kept: page 12 of
   * the file is page 12 even when nothing extracted from it, and compacting the array would
   * shift every number after it.
   */
  pages?: string[];
  meta: Record<string, unknown>;
}

const PDF_PAGE_MARKER = (n: number) => `\n\n--- Page ${n} ---\n\n`;

function extFromName(name: string): string {
  return path.extname(name).toLowerCase();
}

function isPdf(mime: string, ext: string): boolean {
  return mime === 'application/pdf' || ext === '.pdf';
}

function isOfficeDoc(mime: string, ext: string): boolean {
  return (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.pptx' ||
    ext === '.docx'
  );
}

function isPlainText(mime: string, ext: string): boolean {
  return mime === 'text/plain' || mime === 'text/markdown' || ext === '.txt' || ext === '.md';
}

/**
 * A node's text, without the double-counting.
 *
 * officeparser gives every container node the concatenated text of its children as well as
 * giving the children their own, so collecting `text` from the whole subtree repeats each
 * line once per level. Descending stops at the first node that has text, which lands on the
 * paragraphs and reproduces `ast.toText()` exactly, one slide at a time.
 */
function nodeText(node: OfficeContentNode, out: string[]): string[] {
  const text = typeof node.text === 'string' ? node.text.trim() : '';
  if (text) {
    out.push(text);
    return out;
  }
  for (const child of node.children ?? []) nodeText(child, out);
  return out;
}

/**
 * Per-slide text from a parsed .pptx, indexed so that entry i is slide i+1.
 *
 * Keyed by the deck's own slide numbers rather than by array position: a deck with a hidden
 * or unparsed slide leaves a gap, and closing it would renumber everything after it - so the
 * gap is filled with an empty string and slide 14 stays slide 14. Returns undefined for a
 * .docx, which has no slides and no page structure to speak of (Word paginates at render
 * time, so there is nothing here to call a page).
 */
function slideTexts(content: OfficeContentNode[]): string[] | undefined {
  const slides = content.filter(node => node.type === 'slide');
  if (!slides.length) return undefined;

  const byNumber = new Map<number, string>();
  slides.forEach((node, i) => {
    const declared = (node.metadata as { slideNumber?: number } | undefined)?.slideNumber;
    const n = typeof declared === 'number' && declared > 0 ? Math.trunc(declared) : i + 1;
    byNumber.set(n, nodeText(node, []).join('\n'));
  });

  const highest = Math.max(...byNumber.keys());
  return Array.from({ length: highest }, (_, i) => byNumber.get(i + 1) ?? '');
}

/**
 * Extract text from an uploaded file. Throws for unsupported types - the caller
 * (routes/imports.ts) turns that into a failed import job with a readable error.
 */
export async function extractFromUpload(filePath: string, mime: string, originalName: string): Promise<ExtractResult> {
  const ext = extFromName(originalName);

  if (isPdf(mime, ext)) {
    const buf = await fsp.readFile(filePath);
    // unpdf rejects a Node Buffer (even though it is a Uint8Array subclass) and
    // requires a plain Uint8Array view over the same bytes.
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const { totalPages, text } = await extractText(data, { mergePages: false });
    const pages = text.map(page => page.trim());
    const joined = pages
      .map((page, i) => `${PDF_PAGE_MARKER(i + 1)}${page}`)
      .join('')
      .trim();
    return { text: joined, pages, meta: { kind: 'pdf', pages: totalPages } };
  }

  if (isOfficeDoc(mime, ext)) {
    const ast = await parseOffice(filePath, { extractAttachments: false });
    const text = ast.toText().trim();
    return {
      text,
      pages: slideTexts(ast.content),
      meta: { kind: ext === '.pptx' ? 'slides' : 'document', sections: ast.content.length },
    };
  }

  if (isPlainText(mime, ext)) {
    const text = (await fsp.readFile(filePath, 'utf8')).trim();
    return { text, meta: { kind: 'text' } };
  }

  throw new Error(`Unsupported file type for extraction: ${mime || ext || 'unknown'}`);
}
