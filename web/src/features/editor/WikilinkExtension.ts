// Custom atomic inline node for [[Wikilinks]]. Triggered by typing '[[' (Suggestion),
// autocompletes from api.searchTitles, offers "Create note: X", renders as an accent
// link with a hover preview (WikilinkView), and serializes back to plain-text
// `[[Title]]` via renderText so contentText feeds server-side link extraction
// (see docs/API.md PATCH /api/notes/:id).
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import WikilinkView from './WikilinkView';
import WikilinkList from './WikilinkList';
import { createSuggestionRenderer } from './suggestionRenderer';
import type { NotebookLite } from '../../lib/types';

export interface WikilinkSuggestionItem {
  __create?: boolean;
  id: string;
  title: string;
  notebook?: NotebookLite;
  updatedAt?: string;
}

export interface WikilinkOptions {
  HTMLAttributes: Record<string, unknown>;
  getNotebookId: () => string;
}

export const WikilinkPluginKey = new PluginKey('folio-wikilink');

const Wikilink = Node.create<WikilinkOptions>({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      getNotebookId: () => '',
    };
  },

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-note-id'),
        renderHTML: (attrs) => ({ 'data-note-id': attrs.noteId }),
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') || el.textContent || '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title }),
      },
      alias: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-alias'),
        renderHTML: (attrs) => (attrs.alias ? { 'data-alias': attrs.alias } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-wikilink]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-wikilink': '',
        class: 'folio-wikilink',
        href: `/note/${node.attrs.noteId}`,
      }),
      (node.attrs.alias || node.attrs.title || 'Untitled') as string,
    ];
  },

  renderText({ node }) {
    // Always serialize the plain [[Title]] form into editor.getText() (no alias
    // pipe) so the server's link extractor (lib/links.ts) resolves the target by
    // its canonical title. The alias only affects on-screen rendering.
    return `[[${node.attrs.title}]]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikilinkView);
  },

  addProseMirrorPlugins() {
    const suggestion: Partial<SuggestionOptions<WikilinkSuggestionItem>> = {
      char: '[[',
      pluginKey: WikilinkPluginKey,
      allowSpaces: true,
      startOfLine: false,
      debounce: 150,
      items: async ({ query }) => {
        let results: WikilinkSuggestionItem[] = [];
        try {
          const res = await api.searchTitles(query, 8);
          results = res.results;
        } catch {
          // network hiccup — fall through to just the create-row below
        }
        const q = query.trim();
        if (q) {
          const exists = results.some((r) => r.title.toLowerCase() === q.toLowerCase());
          if (!exists) results = [...results, { __create: true, id: '', title: q }];
        }
        return results;
      },
      render: createSuggestionRenderer(WikilinkList),
      command: ({ editor, range, props }) => {
        const item = props as WikilinkSuggestionItem;
        if (item.__create) {
          const notebookId = this.options.getNotebookId();
          if (!notebookId) {
            toast('Could not determine which notebook to create the note in', 'error');
            editor.chain().focus().deleteRange(range).run();
            return;
          }
          api
            .createNote({ notebookId, title: item.title })
            .then(({ note }) => {
              editor
                .chain()
                .focus()
                .insertContentAt(range, { type: 'wikilink', attrs: { noteId: note.id, title: note.title } })
                .run();
              toast(`Created "${note.title}"`, 'ok');
            })
            .catch((e) => {
              toast(e instanceof Error ? e.message : 'Could not create note', 'error');
              editor.chain().focus().deleteRange(range).run();
            });
        } else {
          editor
            .chain()
            .focus()
            .insertContentAt(range, { type: 'wikilink', attrs: { noteId: item.id, title: item.title } })
            .run();
        }
      },
    };
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});

export default Wikilink;
