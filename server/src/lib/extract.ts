// Turns an uploaded file on disk into raw text for the AI to restructure.
// Supported: PDF (unpdf), PPTX/DOCX (officeparser), TXT/MD (plain read).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractText } from 'unpdf';
import { parseOffice } from 'officeparser';

export interface ExtractResult {
  text: string;
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
    const joined = text
      .map((page, i) => `${PDF_PAGE_MARKER(i + 1)}${page.trim()}`)
      .join('')
      .trim();
    return { text: joined, meta: { kind: 'pdf', pages: totalPages } };
  }

  if (isOfficeDoc(mime, ext)) {
    const ast = await parseOffice(filePath, { extractAttachments: false });
    const text = ast.toText().trim();
    return { text, meta: { kind: ext === '.pptx' ? 'slides' : 'document', sections: ast.content.length } };
  }

  if (isPlainText(mime, ext)) {
    const text = (await fsp.readFile(filePath, 'utf8')).trim();
    return { text, meta: { kind: 'text' } };
  }

  throw new Error(`Unsupported file type for extraction: ${mime || ext || 'unknown'}`);
}
