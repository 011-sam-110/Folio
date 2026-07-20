// Central extension list, shared by the live FolioEditor and the read-only HistoryPanel
// preview so both render notes identically.
import type { Editor, Extensions } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder, CharacterCount } from '@tiptap/extensions';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import Mathematics from '@tiptap/extension-mathematics';
import UniqueID from '@tiptap/extension-unique-id';
import { createLowlight, common } from 'lowlight';

import CodeBlockView from './CodeBlockView';
import Callout from './Callout';
import Wikilink from './WikilinkExtension';
import SlashCommand from './SlashCommand';
import { createMathClickHandler } from './mathEdit';
import { Column, ColumnList } from './Columns';
import { createTextColorExtensions } from './TextColor';

const lowlight = createLowlight(common);

export interface BuildExtensionsOpts {
  editable: boolean;
  editorBox: { current: Editor | null };
  getNotebookId: () => string;
  onTableOfContents?: () => void;
}

const UNIQUE_ID_TYPES = [
  'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList',
  'blockquote', 'codeBlock', 'table', 'image', 'callout', 'details', 'columnList',
];

export function createFolioExtensions(opts: BuildExtensionsOpts): Extensions {
  const CodeBlockWithView = CodeBlockLowlight.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView, { contentDOMElementTag: 'code' });
    },
  });

  const extensions: Extensions = [
    StarterKit.configure({
      codeBlock: false,
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: 'folio-link', rel: 'noopener noreferrer' },
      },
      heading: { levels: [1, 2, 3] },
    }),
    Placeholder.configure({
      placeholder: ({ node }) => {
        if (node.type.name === 'heading') return `Heading ${(node.attrs.level as number) ?? 1}`;
        if (node.type.name === 'blockquote') return 'Quote';
        if (node.type.name === 'paragraph') return "Type '/' for commands…";
        return '';
      },
    }),
    CharacterCount,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true, lastColumnResizable: true, cellMinWidth: 40 } }),
    Image.configure({ HTMLAttributes: { class: 'folio-image' } }),
    Highlight.configure({ multicolor: false }),
    Typography,
    CodeBlockWithView.configure({ lowlight, defaultLanguage: 'plaintext' }),
    Details.configure({ persist: true, HTMLAttributes: { class: 'folio-details' } }),
    DetailsSummary,
    DetailsContent,
    Mathematics.configure({
      katexOptions: { throwOnError: false },
      inlineOptions: { onClick: createMathClickHandler(opts.editorBox, 'inline') },
      blockOptions: { onClick: createMathClickHandler(opts.editorBox, 'block') },
    }),
    UniqueID.configure({ types: UNIQUE_ID_TYPES }),
    Callout,
    Wikilink.configure({ getNotebookId: opts.getNotebookId }),
    ColumnList,
    Column,
    ...createTextColorExtensions(),
  ];

  if (opts.editable) {
    extensions.push(SlashCommand.configure({ context: { onTableOfContents: opts.onTableOfContents } }));
  }

  return extensions;
}
