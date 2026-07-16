// Tiny, best-effort Markdown → TipTap doc JSON converter used only by the
// "Insert into new note" action on an AI answer. Handles paragraphs,
// headings (h1-h3), bullet/ordered lists, blockquotes, and code blocks —
// enough for an AI answer to land as a real, editable note. Inline marks
// (bold/italic/code/links) are flattened to plain text rather than modelled
// as TipTap marks; fine for a first-draft note the student can reformat.
import { marked } from 'marked';

interface TTNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TTNode[];
  text?: string;
}

interface TTDoc {
  type: 'doc';
  content: TTNode[];
}

// marked doesn't export a clean cross-version discriminated union for tokens,
// so we work against the minimal shape this converter actually needs.
interface MarkedToken {
  type: string;
  depth?: number;
  text?: string;
  ordered?: boolean;
  items?: MarkedToken[];
  tokens?: MarkedToken[];
}

export function markdownToDoc(markdown: string): TTDoc {
  const tokens = marked.lexer(markdown ?? '') as unknown as MarkedToken[];
  const content = tokensToNodes(tokens);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }] };
}

function tokensToNodes(tokens: MarkedToken[]): TTNode[] {
  const nodes: TTNode[] = [];
  for (const token of tokens) {
    const node = tokenToNode(token);
    if (node) nodes.push(node);
  }
  return nodes;
}

function tokenToNode(token: MarkedToken): TTNode | null {
  switch (token.type) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, token.depth ?? 1));
      return { type: 'heading', attrs: { level }, content: textToInline(token.text ?? '') };
    }
    case 'paragraph':
      return { type: 'paragraph', content: textToInline(token.text ?? '') };
    case 'blockquote': {
      const inner = token.tokens ? tokensToNodes(token.tokens) : [];
      return { type: 'blockquote', content: inner.length > 0 ? inner : [{ type: 'paragraph', content: [] }] };
    }
    case 'list': {
      const items = (token.items ?? []).map(item => ({
        type: 'listItem',
        content: item.tokens ? listItemContent(item.tokens) : [{ type: 'paragraph', content: textToInline(item.text ?? '') }],
      }));
      return { type: token.ordered ? 'orderedList' : 'bulletList', content: items };
    }
    case 'code': {
      const text = token.text ?? '';
      return { type: 'codeBlock', content: text ? [{ type: 'text', text }] : [] };
    }
    case 'space':
      return null;
    default:
      return token.text ? { type: 'paragraph', content: textToInline(token.text) } : null;
  }
}

function listItemContent(tokens: MarkedToken[]): TTNode[] {
  const nodes = tokensToNodes(tokens);
  return nodes.length > 0 ? nodes : [{ type: 'paragraph', content: [] }];
}

function textToInline(text: string): TTNode[] {
  const plain = stripInlineMarkdown(text);
  return plain ? [{ type: 'text', text: plain }] : [];
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}
