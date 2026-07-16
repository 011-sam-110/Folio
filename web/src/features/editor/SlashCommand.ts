// The '/' Suggestion plugin wiring — pairs SlashItems' catalog with SlashMenu's popup.
import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { createSuggestionRenderer } from './suggestionRenderer';
import SlashMenu from './SlashMenu';
import { getSlashItems, type SlashItem, type SlashCommandContext } from './SlashItems';

export const SlashCommandPluginKey = new PluginKey('folio-slash-command');

export interface SlashCommandOptions {
  context: SlashCommandContext;
}

const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return { context: {} };
  },

  addProseMirrorPlugins() {
    const suggestion: Partial<SuggestionOptions<SlashItem>> = {
      char: '/',
      pluginKey: SlashCommandPluginKey,
      startOfLine: false,
      items: ({ query }) => getSlashItems(query),
      render: createSuggestionRenderer(SlashMenu),
      command: ({ editor, range, props }) => {
        (props as SlashItem).run(editor, range, this.options.context);
      },
    };
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});

export default SlashCommand;
