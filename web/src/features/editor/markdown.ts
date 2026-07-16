// Renders AI-returned markdown to sanitized HTML for preview / insertion into the editor.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

export function markdownToSafeHtml(md: string | null | undefined): string {
  if (!md) return '';
  const raw = marked.parse(md) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
