// TipTap JSON -> Markdown, server-side, for GET /api/notes/:id/export.
// Deliberately defensive: unknown node types degrade to "render children" rather than throwing,
// since the editor's node set can grow without this file being touched.

export interface TTMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TTNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TTNode[];
  text?: string;
  marks?: TTMark[];
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

function renderMarks(text: string, marks: TTMark[] = []): string {
  let out = text;
  const has = (t: string) => marks.some(m => m.type === t);
  if (has('code')) out = '`' + out + '`';
  if (has('bold') || has('strong')) out = `**${out}**`;
  if (has('italic') || has('em')) out = `*${out}*`;
  if (has('strike')) out = `~~${out}~~`;
  if (has('highlight')) out = `==${out}==`;
  const link = marks.find(m => m.type === 'link');
  const href = link?.attrs?.href;
  if (typeof href === 'string' && href) out = `[${out}](${href})`;
  return out;
}

function renderInline(nodes: TTNode[] = []): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(n: TTNode): string {
  if (n.type === 'text') return renderMarks(n.text ?? '', n.marks);
  if (n.type === 'wikilink' || n.type === 'wikiLink') {
    const title = (n.attrs?.title ?? n.attrs?.label ?? n.attrs?.id ?? '') as string;
    return `[[${title}]]`;
  }
  if (n.type === 'hardBreak') return '  \n';
  if (n.type === 'mention') return `@${(n.attrs?.label ?? n.attrs?.id ?? '') as string}`;
  if (n.content) return renderInline(n.content);
  return '';
}

function indentLines(text: string, depth: number): string {
  if (!text) return text;
  const pad = '  '.repeat(depth);
  return text.split('\n').map(l => pad + l).join('\n');
}

function renderList(node: TTNode, depth: number, ordered: boolean, task: boolean): string {
  const items = node.content ?? [];
  const start = typeof node.attrs?.start === 'number' ? (node.attrs.start as number) : 1;
  const pad = '  '.repeat(depth);
  const lines: string[] = [];

  items.forEach((item, i) => {
    const checked = Boolean(item.attrs?.checked);
    const marker = task ? `- [${checked ? 'x' : ' '}]` : ordered ? `${start + i}.` : '-';
    const sub = item.content ?? [];
    const [first, ...rest] = sub;
    const firstText = first ? renderBlockInlineText(first) : '';
    lines.push(`${pad}${marker} ${firstText}`.trimEnd());

    for (const child of rest) {
      if (LIST_TYPES.has(child.type)) {
        lines.push(renderBlock(child, depth + 1));
      } else {
        const rendered = renderBlock(child, 0);
        if (rendered) lines.push(indentLines(rendered, depth + 1));
      }
    }
  });

  return lines.join('\n');
}

/** Inline text for the first paragraph-ish block of a list item. */
function renderBlockInlineText(node: TTNode): string {
  if (node.type === 'paragraph' || node.type === 'heading') return renderInline(node.content);
  return renderInline(node.content);
}

function cellText(cell: TTNode): string {
  const blocks = cell.content ?? [];
  return blocks
    .map(b => renderInline(b.content))
    .join(' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderTable(node: TTNode): string {
  const rows = node.content ?? [];
  if (!rows.length) return '';
  const grid = rows.map(row => (row.content ?? []).map(cellText));
  const colCount = Math.max(...grid.map(r => r.length), 0);
  for (const r of grid) while (r.length < colCount) r.push('');
  const [header, ...body] = grid;
  const headerLine = `| ${header.join(' | ')} |`;
  const sepLine = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = body.map(r => `| ${r.join(' | ')} |`);
  return [headerLine, sepLine, ...bodyLines].join('\n');
}

function renderBlock(node: TTNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content);
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${'#'.repeat(level)} ${renderInline(node.content)}`;
    }
    case 'bulletList':
      return renderList(node, depth, false, false);
    case 'orderedList':
      return renderList(node, depth, true, false);
    case 'taskList':
      return renderList(node, depth, false, true);
    case 'blockquote': {
      const inner = (node.content ?? []).map(c => renderBlock(c, 0)).join('\n\n');
      return inner.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
    }
    case 'codeBlock': {
      const lang = (node.attrs?.language as string) ?? '';
      const code = (node.content ?? []).map(c => c.text ?? '').join('');
      return '```' + lang + '\n' + code + '\n```';
    }
    case 'horizontalRule':
      return '---';
    case 'image': {
      const src = (node.attrs?.src as string) ?? '';
      const alt = (node.attrs?.alt as string) ?? '';
      return `![${alt}](${src})`;
    }
    case 'table':
      return renderTable(node);
    case 'callout': {
      const kind = ((node.attrs?.kind ?? node.attrs?.type ?? 'info') as string).toUpperCase();
      const inner = (node.content ?? []).map(c => renderBlock(c, 0)).join('\n\n');
      return `> [!${kind}]\n` + inner.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
    }
    case 'details': {
      const children = node.content ?? [];
      const summary = children.find(c => c.type === 'detailsSummary');
      const contentNode = children.find(c => c.type === 'detailsContent');
      const summaryText = summary ? renderInline(summary.content) : 'Details';
      const inner = contentNode ? (contentNode.content ?? []).map(c => renderBlock(c, 0)).join('\n\n') : '';
      return `<details>\n<summary>${summaryText}</summary>\n\n${inner}\n\n</details>`;
    }
    default:
      if (node.content) return node.content.map(c => renderBlock(c, depth)).join('\n\n');
      return '';
  }
}

export function tiptapToMarkdown(doc: TTNode | null | undefined): string {
  if (!doc || !Array.isArray(doc.content)) return '';
  const blocks = doc.content.map(n => renderBlock(n, 0));
  return blocks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}
