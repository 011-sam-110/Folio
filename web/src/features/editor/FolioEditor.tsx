// The TipTap editor wrapper: extensions, selection/table bubble menus, drag handle,
// image paste/drop, and outline reporting. Content is only used to seed the editor —
// callers should `key={note.id}` this component to fully reinitialize on note switch.
import { useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { createFolioExtensions } from './buildExtensions';
import SelectionToolbar from './SelectionToolbar';
import TableToolbar from './TableToolbar';
import { uploadAndInsertImage } from './imageUpload';
import { computeOutline, type OutlineItem } from './outline';
import './editor.css';

export interface FolioEditorProps {
  content: JSONContent | Record<string, unknown> | string | null | undefined;
  notebookId: string;
  onReady: (editor: Editor) => void;
  onDestroy: () => void;
  onDocChange: () => void;
  onOutline: (items: OutlineItem[]) => void;
  onTableOfContents?: () => void;
}

export default function FolioEditor({ content, notebookId, onReady, onDestroy, onDocChange, onOutline, onTableOfContents }: FolioEditorProps) {
  const editorBox = useRef<Editor | null>(null);
  const notebookIdRef = useRef(notebookId);
  notebookIdRef.current = notebookId;

  // Stable for this component's lifetime — remount (key={note.id}) to rebuild for a new note.
  const extensions = useMemo(
    () =>
      createFolioExtensions({
        editable: true,
        editorBox,
        getNotebookId: () => notebookIdRef.current,
        onTableOfContents,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: (content ?? '') as JSONContent,
    editorProps: {
      attributes: { class: 'folio-prosemirror', spellcheck: 'true' },
      handleClick(_view, _pos, event) {
        const target = event.target as HTMLElement;
        const link = target.closest?.('a.folio-link') as HTMLAnchorElement | null;
        if (link && (event.ctrlKey || event.metaKey)) {
          window.open(link.href, '_blank', 'noopener,noreferrer');
          return true;
        }
        return false;
      },
      handleDrop(_view, event) {
        const file = event.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('image/')) {
          event.preventDefault();
          if (editorBox.current) uploadAndInsertImage(editorBox.current, file);
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
        if (file) {
          event.preventDefault();
          if (editorBox.current) uploadAndInsertImage(editorBox.current, file);
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => {
      editorBox.current = editor;
      onReady(editor);
      onOutline(computeOutline(editor));
    },
    onUpdate: ({ editor, transaction }) => {
      if (transaction.docChanged) {
        onDocChange();
        onOutline(computeOutline(editor));
      }
    },
    onDestroy: () => {
      editorBox.current = null;
      onDestroy();
    },
  });

  if (!editor) return null;

  return (
    <div className="folio-editor">
      <SelectionToolbar editor={editor} />
      <TableToolbar editor={editor} />
      <DragHandle editor={editor}>
        <div className="folio-drag-handle" aria-hidden="true">
          ⠿
        </div>
      </DragHandle>
      <EditorContent editor={editor} />
    </div>
  );
}
