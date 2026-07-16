// Shared helper: upload an image file to the server and insert it into the editor.
import type { Editor } from '@tiptap/core';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';

export function uploadAndInsertImage(editor: Editor, file: File) {
  const form = new FormData();
  form.append('file', file);
  api
    .uploadImage(form)
    .then(({ url }) => {
      editor.chain().focus().setImage({ src: url, alt: file.name }).run();
    })
    .catch((e) => {
      toast(e instanceof Error ? e.message : 'Image upload failed', 'error');
    });
}

export function pickAndInsertImage(editor: Editor) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) uploadAndInsertImage(editor, file);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
