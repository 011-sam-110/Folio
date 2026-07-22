// Inline #hashtag support: renders every "#tag" in the body as a tag link and lets
// the reader open its filtered view.
//
// WHY a decoration and not a Node (as WikilinkExtension.ts uses): a hashtag must
// stay ordinary text. NotePage parses the tags back out of `editor.getText()` on
// every capture, existing notes already contain plain "#week1" that no migration
// has touched, and a student expects to be able to backspace through "#revision"
// one character at a time. An atom node would break all three. A decoration paints
// the same affordance over text that is still just text.
//
// Registration follows FindReplace.ts's precedent - NotePage calls
// `editor.registerPlugin(createHashtagPlugin(...))` once the editor is ready,
// rather than adding to buildExtensions.ts's shared array - because the click
// handler needs this page's router `navigate`.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { HASHTAG_RE, normalizeTag } from '../../lib/tags';

export const HashtagPluginKey = new PluginKey<DecorationSet>('folioHashtag');

/**
 * Paint every #hashtag in the document.
 *
 * Scans text nodes rather than the flattened document string so the offsets are
 * real ProseMirror positions. Recomputed on every doc change - note bodies are
 * small (the AI size guard caps them near 24k chars) so this costs far less than
 * a keystroke's own re-render, the same trade FindReplace.ts already makes.
 */
function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    // Fresh regex per node: HASHTAG_RE is /g and therefore carries lastIndex state.
    const re = new RegExp(HASHTAG_RE.source, HASHTAG_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.text)) !== null) {
      const tag = normalizeTag(m[1]);
      if (!tag) continue;
      const from = pos + m.index;
      decorations.push(
        Decoration.inline(from, from + m[0].length, {
          class: 'folio-hashtag',
          'data-tag': tag,
          title: `#${tag} (Ctrl+click to browse notes with this tag)`,
        }),
      );
    }
  });
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * @param onOpenTag opens a tag's filtered view.
 *
 * Navigation is bound to Ctrl/Cmd+click, NOT a plain click, on purpose: this is an
 * editable surface, and a plain click on a hashtag has to keep placing the caret or
 * the tag becomes impossible to correct once typed. The chip row above the editor
 * is the plain-click affordance - it shows the same tags and opens on a single
 * click - so nothing is unreachable, and the decoration's tooltip states the
 * modifier.
 */
export function createHashtagPlugin(onOpenTag: (tag: string) => void): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: HashtagPluginKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? buildDecorations(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return HashtagPluginKey.getState(state);
      },
      handleClick(_view, _pos, event) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const target = event.target as HTMLElement | null;
        const el = target?.closest?.('.folio-hashtag');
        const tag = el?.getAttribute('data-tag');
        if (!tag) return false;
        event.preventDefault();
        onOpenTag(tag);
        return true; // handled - don't also move the caret
      },
    },
  });
}
