// TipTap block node for an embedded, interactive 3D model (GLB / glTF / STL / OBJ).
//
// An atom (no editable content): all of its data lives in node attrs, and the whole card is
// rendered by Model3dView. Mirrors the Callout node's shape (Node.create + ReactNodeViewRenderer)
// but with atom:true because there is nothing to type inside a model.
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import Model3dView from './Model3dView';
import type { Model3dFormat } from './model3dUpload';

export interface Model3dOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** The node's persisted shape (uploadKey is transient and never serialized). */
export interface Model3dAttrs {
  /** attachments.id, when the upload endpoint returns it. */
  attachmentId: string | null;
  /** `/uploads/<stored_name>` - the bytes the viewer fetches. Also what the server scans note
   *  content for to file the attachment against the note (claimAttachmentsForNote). */
  url: string | null;
  format: Model3dFormat | null;
  /** Original filename, shown as the label and used for accessibility. */
  fileName: string;
  /** Byte size, for a subtle caption. */
  size: number | null;
  /** Optional poster (data: URL) shown before the heavy renderer initialises. */
  poster: string | null;
  /** Transient: links a freshly-inserted node to its in-flight upload's File. Not rendered. */
  uploadKey: string | null;
}

const Model3d = Node.create<Model3dOptions>({
  name: 'model3d',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-attachment-id'),
        renderHTML: (attrs) => (attrs.attachmentId ? { 'data-attachment-id': attrs.attachmentId } : {}),
      },
      url: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-url'),
        renderHTML: (attrs) => (attrs.url ? { 'data-url': attrs.url } : {}),
      },
      format: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-format'),
        renderHTML: (attrs) => (attrs.format ? { 'data-format': attrs.format } : {}),
      },
      fileName: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-file-name') || '',
        renderHTML: (attrs) => (attrs.fileName ? { 'data-file-name': attrs.fileName } : {}),
      },
      size: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-size');
          return v ? Number(v) : null;
        },
        renderHTML: (attrs) => (attrs.size ? { 'data-size': String(attrs.size) } : {}),
      },
      poster: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-poster'),
        renderHTML: (attrs) => (attrs.poster ? { 'data-poster': attrs.poster } : {}),
      },
      // Transient link to an in-flight upload's File; never serialized to HTML.
      uploadKey: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="model3d"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'model3d', class: 'folio-model3d' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(Model3dView);
  },
});

export default Model3d;
