/**
 * The note, as the review prompts see it: a flat list of blocks, each carrying the id the
 * editor already anchors it by.
 *
 * `AiEdit.blockId` is the whole anchoring strategy (see lib/aiEdit.ts), and an anchor only
 * works if the model was shown the id in the first place. So the review routes never send
 * `content_text` - that is a flattened string with no ids in it, and a model asked to point
 * at something in it can only quote text back, which is the fragile anchor this design
 * rejected. They send the output of this module instead.
 *
 * The ids are TipTap `UniqueID` attrs, minted and persisted by the editor (buildExtensions.ts
 * configures it for heading/paragraph/list/table/callout/notation types). Nothing here mints
 * one: an id this file invented would name a block the client cannot find, so a suggestion
 * anchored to it would be dead on arrival and would look like a stale edit rather than a bug.
 */

import { plainTextFromDoc } from './plainText.js';

export interface NoteBlock {
  /** The block's TipTap UniqueID. Exactly what an `AiEdit.blockId` has to echo back. */
  id: string;
  /** TipTap node type, e.g. `paragraph`, `heading`, `bulletList`. Context for the model. */
  type: string;
  /** The block's text, flattened. Never empty - textless blocks are not offered. */
  text: string;
}

/**
 * Ids are rendered into an attribute inside the prompt, and note content is untrusted (a
 * share guest can write it, and an import extracts it from an uploaded file). An id holding
 * a quote or a newline could close the tag early and let the surrounding text pose as prompt
 * structure, so anything outside this alphabet is not escaped but skipped: a block whose id
 * cannot be rendered safely is a block the model should not be anchoring to at all.
 *
 * The editor's own ids are UUIDs, so this excludes nothing the editor produces.
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Flatten a stored `content_json` document into its addressable blocks.
 *
 * Only the OUTERMOST id-bearing node is emitted. `UniqueID` tags by node type wherever the
 * type appears, so a paragraph inside a list item carries an id as well as the list that
 * contains it; emitting both would hand the model two overlapping anchors for one piece of
 * text and let it pick either, which is how the same suggestion arrives twice. A list is
 * therefore one block, and an edit against it still resolves because the plugin matches
 * `before` inside the block rather than against the whole of it.
 *
 * Returns `[]` rather than throwing on unparseable JSON: the caller's answer to "no blocks"
 * is already a clean 400, and a note whose content column is corrupt should not 500.
 */
export function blocksOf(contentJson: string): NoteBlock[] {
  let doc: unknown;
  try {
    doc = JSON.parse(contentJson);
  } catch {
    return [];
  }

  const out: NoteBlock[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };

    const id = typeof n.attrs?.id === 'string' ? n.attrs.id : '';
    if (id && SAFE_ID.test(id) && !seen.has(id)) {
      const text = plainTextFromDoc(n).trim();
      // A textless block (an empty paragraph, a bare image) gives the model nothing to
      // quote and nothing to fix, and every one of them costs prompt budget that a real
      // block could have used.
      if (text) {
        seen.add(id);
        out.push({ id, type: n.type ?? 'block', text });
        // Do not descend: this node is now the anchor for everything inside it.
        return;
      }
    }

    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };

  walk(doc);
  return out;
}

/**
 * Render blocks for a prompt.
 *
 * Tag-shaped rather than `[id] text`, because the block text is arbitrary student writing
 * that can contain brackets, ids, and anything else a lighter format would collide with. The
 * closing line makes the boundary unambiguous even when a block runs to several paragraphs.
 */
export function blocksForPrompt(blocks: NoteBlock[]): string {
  return blocks
    .map(b => `<block id="${b.id}" type="${b.type}">\n${b.text}\n</block>`)
    .join('\n');
}
