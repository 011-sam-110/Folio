// Insert-menu descriptor for the 3D model node.
//
// The parent's Insert menu imports `model3dInsertable` and drops it into its catalog. The
// InsertItem shape below matches the shared contract exactly, so it stays assignable to the
// parent's own `InsertItem` type by structural typing even though that type lives elsewhere.
//
// run() behaviour: it opens the native file picker straight away. Only once a valid model is
// chosen is a node inserted (carrying the picked File via an in-memory key); the node view then
// uploads it and shows inline progress. If the dialog is cancelled, or the file is the wrong
// type / too large, nothing is inserted and the reason is toasted.
import type { Editor } from '@tiptap/core';
import { pickModelFile, stashPendingUpload, formatFromName, MAX_MODEL_BYTES, humanSize } from './model3dUpload';
import { toast } from '../../../../components/Toast';

export type InsertSection = 'Basic' | 'Lists' | 'Notation' | 'Media' | 'Layout' | 'Advanced';

export interface InsertItem {
  id: string;
  title: string;
  description: string;
  icon: string;
  section: InsertSection;
  keywords?: string[];
  run: (editor: Editor, range?: { from: number; to: number }) => void;
}

export const model3dInsertable: InsertItem = {
  id: 'model3d',
  title: '3D model',
  description: 'Embed a rotatable GLB, glTF, STL or OBJ',
  icon: '⬢', // ⬢ - an isometric cube silhouette reads as 3D at glyph size
  section: 'Notation',
  keywords: ['3d', 'model', 'glb', 'gltf', 'stl', 'obj', 'mesh', 'cad', 'three', 'render'],
  run: (editor, range) => {
    // Clear the "/" query range first (if the caller passed one), then open the picker.
    const chain = editor.chain().focus();
    if (range) chain.deleteRange(range);
    chain.run();

    pickModelFile((file) => {
      if (!file) return; // dialog dismissed - insert nothing
      const format = formatFromName(file.name);
      if (!format) {
        toast('That is not a supported 3D model. Use GLB, glTF, STL or OBJ.', 'error');
        return;
      }
      if (file.size > MAX_MODEL_BYTES) {
        toast(`That model is ${humanSize(file.size)} - the limit is ${humanSize(MAX_MODEL_BYTES)}.`, 'error');
        return;
      }
      const uploadKey = stashPendingUpload(file);
      editor
        .chain()
        .focus()
        .insertContent({ type: 'model3d', attrs: { uploadKey, fileName: file.name, format } })
        .run();
    });
  },
};
