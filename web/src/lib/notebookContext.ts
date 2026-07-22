// Tracks which notebook new notes should be filed into, so Ctrl+N / the sidebar '+' /
// quick-switcher "create" always target the notebook you're actually working in - even on
// routes (/note/:id, /study, /ask, /) that don't carry a :notebookId param.
//
// Resolution order: the current route's :notebookId → the open note's notebook (published by
// NotePage) → the last notebook you touched (persisted) → the first notebook.
const LAST_KEY = 'folio:lastNotebook';
let active: string | null = null;

/** Publish the notebook currently in focus (open note or notebook page) and remember it. */
export function setActiveNotebook(id: string | null): void {
  active = id;
  if (id) {
    try {
      localStorage.setItem(LAST_KEY, id);
    } catch {
      // localStorage unavailable - the in-memory `active` still covers the live session.
    }
  }
}

/** Clear the transient active notebook (e.g. on navigating back to the dashboard). */
export function clearActiveNotebook(): void {
  active = null;
}

function getLastNotebook(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Resolve the notebook a new note should be filed into, validating against the live list. */
export function resolveFilingNotebook(paramNotebookId: string | undefined, notebooks: Array<{ id: string }>): string | undefined {
  const ids = new Set(notebooks.map((n) => n.id));
  for (const candidate of [paramNotebookId, active, getLastNotebook()]) {
    if (candidate && ids.has(candidate)) return candidate;
  }
  return notebooks[0]?.id;
}
