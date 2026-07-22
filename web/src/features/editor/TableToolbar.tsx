// Small floating bubble menu shown only while the cursor sits inside a table.
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/core';

export default function TableToolbar({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="folioTableMenu"
      shouldShow={({ editor }) => editor.isActive('table')}
      options={{ placement: 'top', offset: 8 }}
    >
      <div className="folio-bubble folio-table-bubble" role="toolbar" aria-label="Table">
        <button type="button" aria-label="Add row below" title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}>
          +Row
        </button>
        <button type="button" aria-label="Add column right" title="Add column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>
          +Col
        </button>
        <button type="button" aria-label="Delete row" title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
          -Row
        </button>
        <button type="button" aria-label="Delete column" title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>
          -Col
        </button>
        <button type="button" aria-label="Toggle header row" title="Toggle header row" onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
          Header
        </button>
        <span className="folio-bubble-sep" role="separator" aria-orientation="vertical" />
        <button
          type="button"
          title="Delete table"
          className="folio-danger"
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          Delete table
        </button>
      </div>
    </BubbleMenu>
  );
}
