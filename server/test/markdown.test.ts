import { describe, it, expect } from 'vitest';
import { markdownToTipTap, markdownToPlainText } from '../src/lib/markdown.js';

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: Array<{ type: string }>;
}

function walkText(node: JsonNode, acc: string[] = []): string[] {
  if (typeof node.text === 'string') acc.push(node.text);
  node.content?.forEach(child => walkText(child, acc));
  return acc;
}

function findNodes(node: JsonNode, type: string, acc: JsonNode[] = []): JsonNode[] {
  if (node.type === type) acc.push(node);
  node.content?.forEach(child => findNodes(child, type, acc));
  return acc;
}

describe('markdownToTipTap', () => {
  it('produces a doc for empty input rather than throwing', () => {
    expect(markdownToTipTap('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(markdownToTipTap('   \n  ')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('round-trips headings', () => {
    const doc = markdownToTipTap('# Big O Notation\n\n## Growth rates\n\nSome intro text.');
    const headings = findNodes(doc as JsonNode, 'heading');
    expect(headings.length).toBe(2);
    expect(headings[0].attrs?.level).toBe(1);
    expect(headings[1].attrs?.level).toBe(2);
    const allText = walkText(doc as JsonNode).join(' ');
    expect(allText).toContain('Big O Notation');
    expect(allText).toContain('Growth rates');
    expect(allText).toContain('Some intro text.');
  });

  it('round-trips bullet and ordered lists', () => {
    const md = '- First\n- Second\n- Third\n\n1. Step one\n2. Step two';
    const doc = markdownToTipTap(md) as JsonNode;
    expect(findNodes(doc, 'bulletList').length).toBe(1);
    expect(findNodes(doc, 'orderedList').length).toBe(1);
    expect(findNodes(doc, 'listItem').length).toBe(5);
    const allText = walkText(doc).join(' ');
    expect(allText).toContain('First');
    expect(allText).toContain('Second');
    expect(allText).toContain('Third');
    expect(allText).toContain('Step one');
    expect(allText).toContain('Step two');
  });

  it('round-trips GFM task lists as real taskItem nodes with checked state', () => {
    const md = '- [ ] Read chapter 3\n- [x] Submit assignment';
    const doc = markdownToTipTap(md) as JsonNode;
    const taskLists = findNodes(doc, 'taskList');
    const taskItems = findNodes(doc, 'taskItem');
    expect(taskLists.length).toBe(1);
    expect(taskItems.length).toBe(2);
    expect(taskItems[0].attrs?.checked).toBe(false);
    expect(taskItems[1].attrs?.checked).toBe(true);
    const allText = walkText(doc).join(' ');
    expect(allText).toContain('Read chapter 3');
    expect(allText).toContain('Submit assignment');
  });

  it('round-trips fenced code blocks with a language tag', () => {
    const md = '```javascript\nconst x = 1 + 2;\nconsole.log(x);\n```';
    const doc = markdownToTipTap(md) as JsonNode;
    const blocks = findNodes(doc, 'codeBlock');
    expect(blocks.length).toBe(1);
    expect(blocks[0].attrs?.language).toBe('javascript');
    const codeText = walkText(blocks[0]).join('\n');
    expect(codeText).toContain('const x = 1 + 2;');
    expect(codeText).toContain('console.log(x);');
  });

  it('round-trips tables', () => {
    const md = '| Term | Definition |\n| --- | --- |\n| B-tree | Balanced search tree |\n| Index | Speeds up lookups |';
    const doc = markdownToTipTap(md) as JsonNode;
    expect(findNodes(doc, 'table').length).toBe(1);
    expect(findNodes(doc, 'tableRow').length).toBe(3); // header + 2 body rows
    expect(findNodes(doc, 'tableHeader').length).toBe(2);
    expect(findNodes(doc, 'tableCell').length).toBe(4);
    const allText = walkText(doc).join(' ');
    expect(allText).toContain('B-tree');
    expect(allText).toContain('Balanced search tree');
    expect(allText).toContain('Speeds up lookups');
  });

  it('round-trips bold text as a mark, not literal asterisks', () => {
    const doc = markdownToTipTap('This concept is **very important** to remember.') as JsonNode;
    const paragraph = findNodes(doc, 'paragraph')[0];
    const boldNode = paragraph.content?.find(n => n.marks?.some(m => m.type === 'bold'));
    expect(boldNode?.text).toBe('very important');
    const allText = walkText(doc).join('');
    expect(allText).not.toContain('**');
    expect(allText).toContain('very important');
  });

  it('converts [[Wiki Links]] into real wikilink nodes (unresolved → null noteId)', () => {
    const doc = markdownToTipTap('See [[Big O Notation]] and [[Sorting Algorithms|sorting]] for background.') as JsonNode;
    const links = findNodes(doc, 'wikilink');
    expect(links.length).toBe(2);
    expect(links[0].attrs?.title).toBe('Big O Notation');
    expect(links[0].attrs?.noteId).toBeNull();
    expect(links[1].attrs?.title).toBe('Sorting Algorithms');
    expect(links[1].attrs?.alias).toBe('sorting');
    const allText = walkText(doc).join('');
    expect(allText).toContain('See ');
    expect(allText).toContain(' for background.');
  });

  it('resolves a wikilink noteId via the supplied resolver', () => {
    const doc = markdownToTipTap('Link to [[Target]].', (t) => (t.toLowerCase() === 'target' ? 'note123' : null)) as JsonNode;
    const links = findNodes(doc, 'wikilink');
    expect(links.length).toBe(1);
    expect(links[0].attrs?.noteId).toBe('note123');
  });

  it('converts $inline$ and $$display$$ into KaTeX math nodes', () => {
    const doc = markdownToTipTap('Inline $x^2 + y^2 = r^2$ here.\n\n$$E = mc^2$$') as JsonNode;
    const inline = findNodes(doc, 'inlineMath');
    const block = findNodes(doc, 'blockMath');
    expect(inline.length).toBe(1);
    expect(inline[0].attrs?.latex).toBe('x^2 + y^2 = r^2');
    expect(block.length).toBe(1);
    expect(block[0].attrs?.latex).toBe('E = mc^2');
  });

  it('does not rewrite wikilinks or math inside fenced code blocks', () => {
    const doc = markdownToTipTap('```js\nconst a = [[notAlink]]; // $notMath$\n```') as JsonNode;
    expect(findNodes(doc, 'wikilink').length).toBe(0);
    expect(findNodes(doc, 'inlineMath').length).toBe(0);
    const codeText = walkText(findNodes(doc, 'codeBlock')[0]).join('');
    expect(codeText).toContain('[[notAlink]]');
    expect(codeText).toContain('$notMath$');
  });

  it('falls back to a plain paragraph doc instead of crashing on pathological input', () => {
    const weird = '# '.repeat(5000); // absurdly long but not malformed enough to error
    expect(() => markdownToTipTap(weird)).not.toThrow();
    const doc = markdownToTipTap(weird) as JsonNode;
    expect(doc.type).toBe('doc');
    expect(Array.isArray(doc.content)).toBe(true);
  });
});

describe('markdownToPlainText', () => {
  it('strips heading, list, and emphasis syntax while keeping the words', () => {
    const text = markdownToPlainText('# Title\n\n- **Bold** item\n- *Italic* item\n\n> A quote');
    expect(text).not.toMatch(/[#>*]/);
    expect(text).toContain('Title');
    expect(text).toContain('Bold item');
    expect(text).toContain('Italic item');
    expect(text).toContain('A quote');
  });

  it('keeps link text and drops the URL', () => {
    const text = markdownToPlainText('Read the [official docs](https://example.com/docs) first.');
    expect(text).toContain('official docs');
    expect(text).not.toContain('https://example.com');
  });

  it('keeps code content and drops fence markers', () => {
    const text = markdownToPlainText('```python\nprint("hi")\n```');
    expect(text).toContain('print("hi")');
    expect(text).not.toContain('```');
  });

  it('preserves [[wikilinks]] literally', () => {
    const text = markdownToPlainText('See [[Big O Notation]] for details.');
    expect(text).toContain('[[Big O Notation]]');
  });

  it('never throws on empty input', () => {
    expect(markdownToPlainText('')).toBe('');
  });
});
