// Renders AI-returned markdown to sanitized HTML for preview / insertion into the editor.
//
// AI-apply unification (iter1 leftover): every caller that already funnels AI/import
// markdown through `markdownToSafeHtml` — NotePage's Improve/Summarize apply, the
// SelectionToolbar "AI edit" apply, AssistantPanel's "Add to note" — gets live wikilink
// and math NODES for free, with no change needed at any of those call sites, because the
// conversion happens once, here, at the shared choke point. `[[Title]]` / `[[Title|Alias]]`
// become real `wikilink` nodes (unresolved at this synchronous step; WikilinkView resolves
// an exact title match on mount, or falls back to its existing "missing" style — see
// WikilinkView.tsx) and `$...$` / `$$...$$` become inlineMath/blockMath nodes, matching
// exactly what @tiptap/extension-mathematics expects to parse back out of HTML.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

marked.setOptions({ breaks: true, gfm: true });

// A single Unicode Private Use Area codepoint (U+E000) — never produced by `marked` or
// real note text, and neither `marked.parse` nor DOMPurify has any reason to touch it — used
// as an inert delimiter so math spans can round-trip through the markdown→HTML pipeline
// untouched (see `extractMath`/`restoreMath` below).

const MATH_PLACEHOLDER = '';

interface MathToken {
  kind: 'inline' | 'block';
  latex: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Pulls $$...$$ / $...$ out of the raw markdown BEFORE `marked` ever sees it — LaTeX's own
// underscores/asterisks/braces would otherwise get misread as markdown emphasis/lists — and
// swaps in inert placeholder tokens (private-use-area characters `marked` and DOMPurify both
// leave completely alone) to be restored once the real HTML conversion is done.
function extractMath(markdown: string): { text: string; tokens: MathToken[] } {
  const tokens: MathToken[] = [];
  const placeholder = (kind: MathToken['kind']) => (_match: string, latex: string) => {
    const i = tokens.length;
    tokens.push({ kind, latex: latex.trim() });
    return `${MATH_PLACEHOLDER}${i}${MATH_PLACEHOLDER}`;
  };
  // Block math ($$...$$) first — across lines, non-greedy — so the inline pass below never
  // gets a chance to split a block span in half.
  let text = markdown.replace(/\$\$([\s\S]+?)\$\$/g, placeholder('block'));
  // Inline math ($...$) — single line, and the content can't start with whitespace so bare
  // currency like "$5 and $10" doesn't get misread as a math span.
  text = text.replace(/\$([^\s$][^$\n]*?)\$/g, placeholder('inline'));
  return { text, tokens };
}

function restoreMath(html: string, tokens: MathToken[]): string {
  const re = new RegExp(`${MATH_PLACEHOLDER}(\\d+)${MATH_PLACEHOLDER}`, 'g');
  return html.replace(re, (_match, idxStr: string) => {
    const token = tokens[Number(idxStr)];
    if (!token) return '';
    const latex = escapeAttr(token.latex);
    return token.kind === 'block'
      ? `<div data-type="block-math" data-latex="${latex}"></div>`
      : `<span data-type="inline-math" data-latex="${latex}"></span>`;
  });
}

// `[[Title]]` / `[[Title|Alias]]` isn't markdown `marked` understands, so it always survives
// `marked.parse` as literal text (mirrors the server's own extraction regex in
// server/src/lib/links.ts). Converting it here means it becomes a genuine wikilink node the
// instant this HTML lands in the editor.
const WIKILINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;

function linkifyWikilinks(html: string): string {
  return html.replace(WIKILINK_RE, (match, rawTitle: string, rawAlias?: string) => {
    const title = rawTitle.trim();
    if (!title) return match;
    const alias = rawAlias?.trim();
    const aliasAttr = alias ? ` data-alias="${escapeAttr(alias)}"` : '';
    const label = escapeAttr(alias || title);
    return `<a data-wikilink data-title="${escapeAttr(title)}"${aliasAttr}>${label}</a>`;
  });
}

export function markdownToSafeHtml(md: string | null | undefined): string {
  if (!md) return '';
  const { text, tokens } = extractMath(md);
  const raw = marked.parse(text) as string;
  const sanitized = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  return linkifyWikilinks(restoreMath(sanitized, tokens));
}

// Static (non-editor) preview of AI markdown — e.g. AiPreviewModal's "After" pane — can't run
// the Mathematics extension's own KaTeX node view (there's no live TipTap instance backing a
// `dangerouslySetInnerHTML` block), so the inline/block math markup `markdownToSafeHtml` emits
// would otherwise render as empty, invisible tags. This renders the same KaTeX output
// client-side for that read-only context only; once the HTML is set as real editor content
// the live node view takes over as usual.
export function renderMathForPreview(html: string): string {
  return html
    .replace(/<div data-type="block-math" data-latex="([^"]*)"><\/div>/g, (_match, latex: string) => {
      const raw = unescapeAttr(latex);
      try {
        return `<div class="folio-preview-math folio-preview-math--block">${katex.renderToString(raw, { throwOnError: false, displayMode: true })}</div>`;
      } catch {
        return `<div class="folio-preview-math folio-preview-math--block">${escapeAttr(raw)}</div>`;
      }
    })
    .replace(/<span data-type="inline-math" data-latex="([^"]*)"><\/span>/g, (_match, latex: string) => {
      const raw = unescapeAttr(latex);
      try {
        return `<span class="folio-preview-math">${katex.renderToString(raw, { throwOnError: false, displayMode: false })}</span>`;
      } catch {
        return `<span class="folio-preview-math">${escapeAttr(raw)}</span>`;
      }
    });
}
