// The browser-local stand-in for the server API while guest mode is on.
//
// Every page in the shell talks to `lib/api`, so guest mode is implemented once, here,
// rather than as a second set of pages. Three kinds of entry live in this file:
//
//   LOCAL    - answered from guestStore, in exactly the DTO shape the server returns.
//   EMPTY    - answered with a valid empty result, because the surface is harmless
//              without a server (a note has no comments, no history, no ink) and an
//              error there would show a broken panel instead of an empty one.
//   BLOCKED  - rejected with a sentence naming what an account would buy. Nothing calls
//              the server: the endpoints all require a session, so a guest reaching one
//              would only ever collect a 401.
//
// Anything absent from this table is BLOCKED by default (see lib/api.ts), which is the
// safe direction: a new endpoint is unavailable to guests until someone decides otherwise.
import type {
  DashboardData, Flashcard, Note, NoteLite, Notebook, SearchResult, StudyStats, TitleResult,
} from '../../lib/types';
import {
  createNote as storeCreateNote,
  createNotebook as storeCreateNotebook,
  deleteNote as storeDeleteNote,
  deleteNotebook as storeDeleteNotebook,
  notebookOf,
  readData,
  toNote,
  toNoteLite,
  toNotebook,
  updateNote as storeUpdateNote,
  updateNotebook as storeUpdateNotebook,
  wordCountOf,
  writeData,
  type GuestNote,
} from './guestStore';

/**
 * A feature that genuinely needs a server, refused in words a student can act on.
 * `errorMessage()` reads `.message`, so every existing toast and error panel in the app
 * shows this sentence without any of them knowing guest mode exists.
 */
export class GuestFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestFeatureError';
  }
}

/** Per-endpoint refusals. The default covers anything not named here. */
const BLOCKED: Record<string, string> = {
  aiImprove: 'Make an account to use AI. It runs on the server, so there is nothing to run it on here.',
  aiSummarize: 'Make an account to use AI. It runs on the server, so there is nothing to run it on here.',
  aiFlashcards: 'Make an account to turn a note into flashcards.',
  aiAsk: 'Make an account to ask questions across your notes.',
  aiTitle: 'Make an account to use AI.',
  aiSuggest: 'Make an account to use AI review.',
  aiGaps: 'Make an account to use AI.',
  aiGapEdits: 'Make an account to use AI.',
  aiUsage: 'Make an account to use AI.',
  aiSaveKey: 'Make an account to save an AI key.',
  aiDeleteKey: 'Make an account to manage an AI key.',
  snapshot: 'Make an account to keep note history. Nothing is saved while you are trying Unote out.',
  restore: 'Make an account to keep note history.',
  version: 'Make an account to keep note history.',
  undeleteNote: 'Make an account to undo a delete. A deleted note is gone straight away here.',
  addComment: 'Make an account to leave comments on a note.',
  updateComment: 'Make an account to leave comments on a note.',
  deleteComment: 'Make an account to leave comments on a note.',
  createCard: 'Make an account to build a flashcard deck.',
  updateCard: 'Make an account to build a flashcard deck.',
  deleteCard: 'Make an account to build a flashcard deck.',
  review: 'Make an account to review flashcards. The schedule has to live somewhere it survives this browser.',
  createTemplate: 'Make an account to save your own templates.',
  deleteTemplate: 'Make an account to save your own templates.',
  createShare: 'Make an account to share a note. A share link has to be served from somewhere.',
  shares: 'Make an account to share a note.',
  revokeShare: 'Make an account to share a note.',
  addInk: 'Make an account to draw on a note.',
  deleteInk: 'Make an account to draw on a note.',
  clearInk: 'Make an account to draw on a note.',
  createCanvasItem: 'Make an account to use boards.',
  updateCanvasItems: 'Make an account to use boards.',
  deleteCanvasItem: 'Make an account to use boards.',
  createCanvasEdge: 'Make an account to use boards.',
  deleteCanvasEdge: 'Make an account to use boards.',
  import: 'Make an account to import slides, photos and recordings. Reading them needs the server.',
  importJob: 'Make an account to import slides, photos and recordings.',
  uploadImage: 'Make an account to put images in a note. There is nowhere to keep the file otherwise.',
  createImportBatch: 'Make an account to use the import wizard. You can still bring in Markdown from the sidebar.',
  importSources: 'Make an account to use the import wizard.',
  importLabelSpace: 'Make an account to use the import wizard.',
  getImportBatch: 'Make an account to use the import wizard.',
  addImportItems: 'Make an account to use the import wizard.',
  uploadImportFile: 'Make an account to use the import wizard.',
  categoriseImport: 'Make an account to use the import wizard.',
  decideImportItem: 'Make an account to use the import wizard.',
  commitImport: 'Make an account to use the import wizard.',
  discardImportBatch: 'Make an account to use the import wizard.',
  meta: 'Make an account to see server details.',
  qr: 'Make an account to capture notes from your phone. The phone has to reach your account, not this browser.',
  unlinkedMentions: 'Make an account to see unlinked mentions.',
};

const DEFAULT_BLOCKED = 'Make an account to use this. It needs a server, and nothing here is saved to one.';

export function guestBlockedMessage(method: string): string {
  return BLOCKED[method] ?? DEFAULT_BLOCKED;
}

function notFound(what: string): never {
  throw new GuestFeatureError(`That ${what} is not in this browser any more.`);
}

// --- helpers --------------------------------------------------------------------

function sortedNotes(): GuestNote[] {
  return readData().notes.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Strip anything the snippet renderer would treat as markup - it only ever expects
 *  plain text plus the <mark> spans this adds itself. */
function plain(s: string): string {
  return s.replace(/[<>]/g, ' ');
}

function markSnippet(text: string, query: string): string {
  const clean = plain(text).replace(/\s+/g, ' ').trim();
  const at = clean.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return clean.slice(0, 180);
  const from = Math.max(0, at - 60);
  const head = from > 0 ? '…' : '';
  return `${head}${clean.slice(from, at)}<mark>${clean.slice(at, at + query.length)}</mark>${clean.slice(at + query.length, at + query.length + 100)}`;
}

function matches(n: GuestNote, q: string): boolean {
  const needle = q.toLowerCase();
  return n.title.toLowerCase().includes(needle) || n.contentText.toLowerCase().includes(needle) || n.tags.some((t) => t.toLowerCase().includes(needle));
}

// --- the table ------------------------------------------------------------------

export const guestApi = {
  // notebooks
  notebooks: async (): Promise<{ notebooks: Notebook[] }> => {
    const data = readData();
    return { notebooks: data.notebooks.map((nb) => toNotebook(nb, data.notes)) };
  },
  createNotebook: async (b: { name: string; emoji?: string; color?: string }): Promise<{ notebook: Notebook }> => {
    const nb = storeCreateNotebook(b);
    return { notebook: toNotebook(nb, readData().notes) };
  },
  updateNotebook: async (id: string, b: Partial<Notebook>): Promise<{ notebook: Notebook }> => {
    const nb = storeUpdateNotebook(id, b);
    if (!nb) notFound('notebook');
    return { notebook: toNotebook(nb, readData().notes) };
  },
  deleteNotebook: async (id: string): Promise<{ ok: true }> => {
    storeDeleteNotebook(id);
    return { ok: true };
  },

  // notes
  notes: async (q: { notebookId?: string; tag?: string; archived?: boolean; sort?: string; limit?: number; offset?: number } = {}): Promise<{ notes: NoteLite[]; total: number }> => {
    const data = readData();
    let list = data.notes.filter((n) => n.archived === (q.archived ?? false));
    if (q.notebookId) list = list.filter((n) => n.notebookId === q.notebookId);
    if (q.tag) list = list.filter((n) => n.tags.includes(q.tag as string));
    list.sort((a, b) => {
      if (q.sort === 'title') return a.title.localeCompare(b.title);
      if (q.sort === 'created') return a.createdAt < b.createdAt ? 1 : -1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
    const total = list.length;
    const offset = q.offset ?? 0;
    const page = list.slice(offset, offset + (q.limit ?? total));
    return { notes: page.map((n) => toNoteLite(n, notebookOf(data, n.notebookId))), total };
  },
  recentNotes: async (limit = 12): Promise<{ notes: NoteLite[] }> => {
    const data = readData();
    return { notes: sortedNotes().filter((n) => !n.archived).slice(0, limit).map((n) => toNoteLite(n, notebookOf(data, n.notebookId))) };
  },
  note: async (id: string): Promise<{ note: Note; backlinks: NoteLite[]; outgoingLinks: NoteLite[] }> => {
    const data = readData();
    const n = data.notes.find((x) => x.id === id);
    if (!n) notFound('note');
    return { note: toNote(n, notebookOf(data, n.notebookId)), backlinks: [], outgoingLinks: [] };
  },
  createNote: async (b: { notebookId: string; title?: string; contentJson?: unknown; contentText?: string; tags?: string[]; kind?: string }): Promise<{ note: Note }> => {
    if (b.kind === 'canvas') {
      throw new GuestFeatureError('Make an account to use boards. Only written notes work without one.');
    }
    const data = readData();
    if (!notebookOf(data, b.notebookId)) notFound('notebook');
    const created = storeCreateNote({
      notebookId: b.notebookId,
      title: b.title,
      contentJson: b.contentJson as Record<string, unknown> | undefined,
      contentText: b.contentText,
      tags: b.tags,
    });
    return { note: toNote(created, notebookOf(readData(), created.notebookId)) };
  },
  updateNote: async (id: string, b: Partial<{ title: string; contentJson: unknown; contentText: string; pinned: boolean; archived: boolean; notebookId: string; tags: string[] }>): Promise<{ note: Note }> => {
    const patch: Partial<GuestNote> = {};
    if (b.title !== undefined) patch.title = b.title;
    if (b.contentJson !== undefined) patch.contentJson = b.contentJson as Record<string, unknown>;
    if (b.contentText !== undefined) patch.contentText = b.contentText;
    if (b.pinned !== undefined) patch.pinned = b.pinned;
    if (b.archived !== undefined) patch.archived = b.archived;
    if (b.notebookId !== undefined) patch.notebookId = b.notebookId;
    if (b.tags !== undefined) patch.tags = [...new Set(b.tags)];
    const updated = storeUpdateNote(id, patch);
    if (!updated) notFound('note');
    return { note: toNote(updated, notebookOf(readData(), updated.notebookId)) };
  },
  deleteNote: async (id: string): Promise<{ ok: true }> => {
    storeDeleteNote(id);
    return { ok: true };
  },

  // Panels that are simply empty without a server, rather than broken.
  versions: async () => ({ versions: [] }),
  comments: async () => ({ comments: [] }),
  ink: async () => ({ strokes: [] }),
  canvas: async () => ({ items: [], edges: [] }),
  templates: async () => ({ templates: [] }),

  // search + tags
  search: async (q: string, limit = 20): Promise<{ results: SearchResult[] }> => {
    const data = readData();
    const term = q.trim();
    if (!term) return { results: [] };
    const hits = data.notes.filter((n) => matches(n, term)).slice(0, limit);
    return {
      results: hits.map((n) => ({
        note: toNoteLite(n, notebookOf(data, n.notebookId)),
        snippetHtml: markSnippet(n.contentText || n.title, term),
        score: 1,
      })),
    };
  },
  searchFull: async (q: string, limit = 50) => guestApi.search(q, limit),
  searchTitles: async (q: string, limit = 10): Promise<{ results: TitleResult[] }> => {
    const data = readData();
    const term = q.trim().toLowerCase();
    const hits = data.notes
      .filter((n) => !term || n.title.toLowerCase().includes(term))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
    return {
      results: hits.map((n) => ({
        id: n.id,
        title: n.title,
        notebook: toNoteLite(n, notebookOf(data, n.notebookId)).notebook,
        updatedAt: n.updatedAt,
      })),
    };
  },
  tags: async (): Promise<{ tags: Array<{ tag: string; count: number }> }> => {
    const counts = new Map<string, number>();
    for (const n of readData().notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { tags: [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) };
  },
  renameTag: async (tag: string, next: string) => {
    const data = readData();
    let updated = 0;
    for (const n of data.notes) {
      if (!n.tags.includes(tag)) continue;
      n.tags = [...new Set(n.tags.map((t) => (t === tag ? next : t)))];
      updated++;
    }
    writeData(data);
    return { ok: true as const, tag: next, updated };
  },
  deleteTag: async (tag: string) => {
    const data = readData();
    let updated = 0;
    for (const n of data.notes) {
      if (!n.tags.includes(tag)) continue;
      n.tags = n.tags.filter((t) => t !== tag);
      updated++;
    }
    writeData(data);
    return { ok: true as const, tag, updated };
  },
  mergeTags: async (from: string[], into: string) => {
    const data = readData();
    let updated = 0;
    for (const n of data.notes) {
      if (!n.tags.some((t) => from.includes(t))) continue;
      n.tags = [...new Set(n.tags.map((t) => (from.includes(t) ? into : t)))];
      updated++;
    }
    writeData(data);
    return { ok: true as const, tag: into, merged: from, updated };
  },

  // study - no scheduler without a server, so the counts are honestly zero.
  studyStats: async (): Promise<StudyStats> => ({ due: 0, total: 0, reviewedToday: 0, byNote: [] }),
  studyQueue: async (): Promise<{ cards: Flashcard[]; due: number; total: number }> => ({ cards: [], due: 0, total: 0 }),
  studyCards: async (): Promise<{ cards: Flashcard[] }> => ({ cards: [] }),

  /**
   * AI is off for guests, reported through the same health probe every AI control already
   * gates on (lib/aiStatus). That is what makes the AI buttons remove themselves instead of
   * rendering as live controls that always fail.
   */
  aiHealth: async () => ({
    ok: false,
    reason: 'not_configured' as const,
    hint: 'AI needs an account. Make one and it turns on.',
  }),

  dashboard: async (): Promise<DashboardData> => {
    const data = readData();
    const live = data.notes.filter((n) => !n.archived);
    const byUpdated = live.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const lite = (n: GuestNote) => toNoteLite(n, notebookOf(data, n.notebookId));

    // Monday-first week, in the browser's own timezone so "today" lines up with the column
    // DashboardPage highlights.
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const weekKeys = DAY_LABELS.map((_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return localDayKey(d);
    });
    const weekGrid = weekKeys.map((date, i) => {
      const onDay = live.filter((n) => localDayKey(new Date(n.updatedAt)) === date);
      const perNotebook = new Map<string, number>();
      for (const n of onDay) perNotebook.set(n.notebookId, (perNotebook.get(n.notebookId) ?? 0) + 1);
      return {
        date,
        dayLabel: DAY_LABELS[i],
        total: onDay.length,
        byNotebook: [...perNotebook].flatMap(([id, count]) => {
          const nb = notebookOf(data, id);
          return nb ? [{ id, emoji: nb.emoji, color: nb.color, count }] : [];
        }),
      };
    });

    const weekStart = new Date(monday);
    weekStart.setHours(0, 0, 0, 0);
    const editedThisWeek = live.filter((n) => new Date(n.updatedAt) >= weekStart).length;

    return {
      recent: byUpdated.slice(0, 12).map(lite),
      pinned: live.filter((n) => n.pinned).map(lite),
      continueNote: byUpdated[0] ? lite(byUpdated[0]) : null,
      stats: {
        notes: live.length,
        notebooks: data.notebooks.filter((n) => !n.archived).length,
        words: live.reduce((sum, n) => sum + wordCountOf(n.contentText), 0),
        flashcardsDue: 0,
      },
      weekActivity: weekGrid.map((d) => ({ date: d.date, count: d.total })),
      notebooks: data.notebooks.filter((n) => !n.archived).map((nb) => {
        const full = toNotebook(nb, data.notes);
        return { id: full.id, name: full.name, emoji: full.emoji, color: full.color, noteCount: full.noteCount, lastNoteAt: full.lastNoteAt };
      }),
      weekGrid,
      weeklyReview: {
        notesEditedThisWeek: editedThisWeek,
        flashcardsDue: 0,
        notesWithoutSummary: 0,
        unresolvedComments: 0,
        suggestions: ['Nothing here is saved. Make an account to keep it.'],
      },
      recall: [],
    };
  },

  /** Per-note export is handled in the browser (see guestExport), so there is no URL to
   *  hand the browser. Callers check for guest mode before reaching for this. */
  exportUrl: () => '',
};

export type GuestApi = typeof guestApi;
