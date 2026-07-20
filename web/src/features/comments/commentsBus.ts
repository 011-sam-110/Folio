// Tiny pub/sub so SelectionToolbar (mounted inside FolioEditor, which we don't own) can tell
// CommentsPanel (mounted as a sibling under NoteWorkspace) "a comment was just added, refetch" —
// with no prop channel between the two since neither owns the file the other is rendered from.
// Mirrors autosaveBus.ts's "single active listener" shape (only one note page is open at a time).
type Listener = () => void;

let activeListener: Listener | null = null;

export function setCommentsListener(fn: Listener | null): void {
  activeListener = fn;
}

export function notifyCommentAdded(): void {
  activeListener?.();
}
