// The "/" Suggestion plugin wiring - pairs the shared Insert catalog (insertables.ts)
// with SlashMenu's popup. The catalog is the same one the gutter "+" and toolbar use.
import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { createSuggestionRenderer } from './suggestionRenderer';
import SlashMenu from './SlashMenu';
import { getInsertItems, type InsertItem } from './insertables';

export const SlashCommandPluginKey = new PluginKey('folio-slash-command');

const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    const suggestion: Partial<SuggestionOptions<InsertItem>> = {
      char: '/',
      pluginKey: SlashCommandPluginKey,
      startOfLine: false,
      items: ({ query }) => getInsertItems(query),
      render: createSuggestionRenderer(SlashMenu),
      command: ({ editor, range, props }) => {
        // The "/" path passes the query range so the item deletes the typed command first.
        (props as InsertItem).run(editor, range);
      },
    };
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});

export default SlashCommand;
