// Lets in-editor navigation (e.g. clicking a wikilink) flush the currently-open
// note's pending autosave *before* it leaves, so a just-made edit (like the link
// you're following) is durably persisted and visible on the destination note -
// rather than racing the next page's data fetch. Only one note editor is mounted
// at a time, so a single active flusher is enough.
type Flusher = () => Promise<void>;

let activeFlush: Flusher | null = null;

export function setActiveFlush(fn: Flusher | null): void {
  activeFlush = fn;
}

export async function flushActiveNote(): Promise<void> {
  if (activeFlush) {
    try {
      await activeFlush();
    } catch {
      // A failed save shouldn't block navigation - the autosave chip surfaces the error.
    }
  }
}
