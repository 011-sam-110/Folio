// Margin comment anchor: a plain inline mark carrying only `commentId`. The comment's
// text (body, resolved state, anchorText snapshot) lives server-side in note_comments -
// this mark just anchors a comment to a live span of text in the document so
// CommentsPanel can scroll-to/flash it, and so we can tell a comment is "orphaned"
// (its mark got deleted/edited away) by checking whether any mark with that id remains.
//
// Cross-agent contract (docs/ITER2-PLAN.md): editor-blocks imports this EXACT named
// export into buildExtensions.ts via `import { CommentMark } from '../comments/CommentMark'`.
// This file only ever exports the name `CommentMark` - do not rename it.
import { Mark, mergeAttributes } from '@tiptap/core';

export interface CommentMarkOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Apply the comment mark (carrying commentId) to the current selection. */
      setComment: (commentId: string) => ReturnType;
      /** Remove the comment mark from the current selection. */
      unsetComment: () => ReturnType;
    };
  }
}

export const CommentMark = Mark.create<CommentMarkOptions>({
  name: 'comment',

  // Don't let the mark "grow" to swallow text typed immediately after it - a comment
  // anchors the text that existed when it was created, not whatever gets typed next.
  inclusive: false,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => (attrs.commentId ? { 'data-comment-id': attrs.commentId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: 'folio-comment-mark' }), 0];
  },

  addCommands() {
    return {
      setComment:
        (commentId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { commentId }),
      unsetComment:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

export default CommentMark;
