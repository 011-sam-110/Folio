import type {
  DashboardData, Flashcard, ImportJob, MetaInfo, Note, NoteLite, NotebookLite, Notebook,
  NoteComment, NoteVersion, NoteVersionMeta, SearchParsed, SearchResult, StudyStats,
  Template, TitleResult, User,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Session-expiry hook. A 401 from any non-auth endpoint means the session cookie
 * expired or was revoked (e.g. a password change elsewhere), and every caller
 * would otherwise render its own half-broken error state. AuthContext registers a
 * handler here and turns the event into a single redirect to /login.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const isJson = res.headers.get('content-type')?.includes('application/json');
  if (!res.ok) {
    // The auth endpoints own their 401s — a wrong password and the signed-out /me
    // probe are both expected answers, not expired sessions — so they must not
    // trip the global handler and bounce the user mid-login.
    if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler?.();
    let msg = `${res.status} ${res.statusText}`;
    if (isJson) {
      const body = await res.json().catch(() => null);
      if (body?.error) msg = body.error;
    }
    throw new ApiError(msg, res.status);
  }
  return (isJson ? res.json() : res.text()) as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  // auth — no tokens are passed or returned: the session is an httpOnly cookie the
  // browser attaches automatically on these same-origin requests.
  signup: (b: { email: string; password: string; displayName?: string }) =>
    http<{ user: User }>('/api/auth/signup', json('POST', b)),
  login: (b: { email: string; password: string }) => http<{ user: User }>('/api/auth/login', json('POST', b)),
  logout: () => http<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => http<{ user: User }>('/api/auth/me'),
  changePassword: (b: { currentPassword: string; newPassword: string }) =>
    http<{ ok: true }>('/api/auth/password', json('POST', b)),

  // notebooks
  notebooks: () => http<{ notebooks: Notebook[] }>('/api/notebooks'),
  createNotebook: (b: { name: string; emoji?: string; color?: string }) => http<{ notebook: Notebook }>('/api/notebooks', json('POST', b)),
  updateNotebook: (id: string, b: Partial<Pick<Notebook, 'name' | 'emoji' | 'color' | 'position' | 'archived'>>) =>
    http<{ notebook: Notebook }>(`/api/notebooks/${id}`, json('PATCH', b)),
  deleteNotebook: (id: string) => http<{ ok: true }>(`/api/notebooks/${id}`, { method: 'DELETE' }),

  // notes
  notes: (q: { notebookId?: string; tag?: string; archived?: boolean; sort?: 'updated' | 'created' | 'title'; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.notebookId) p.set('notebookId', q.notebookId);
    if (q.tag) p.set('tag', q.tag);
    if (q.archived !== undefined) p.set('archived', q.archived ? '1' : '0');
    if (q.sort) p.set('sort', q.sort);
    if (q.limit) p.set('limit', String(q.limit));
    if (q.offset) p.set('offset', String(q.offset));
    return http<{ notes: NoteLite[]; total: number }>(`/api/notes?${p}`);
  },
  recentNotes: (limit = 12) => http<{ notes: NoteLite[] }>(`/api/notes/recent?limit=${limit}`),
  note: (id: string) => http<{ note: Note; backlinks: NoteLite[]; outgoingLinks: NoteLite[] }>(`/api/notes/${id}`),
  createNote: (b: { notebookId: string; title?: string; contentJson?: unknown; contentText?: string; tags?: string[] }) =>
    http<{ note: Note }>('/api/notes', json('POST', b)),
  updateNote: (id: string, b: Partial<{ title: string; contentJson: unknown; contentText: string; pinned: boolean; archived: boolean; notebookId: string; tags: string[] }>) =>
    http<{ note: Note }>(`/api/notes/${id}`, json('PATCH', b)),
  deleteNote: (id: string) => http<{ ok: true }>(`/api/notes/${id}`, { method: 'DELETE' }),
  undeleteNote: (id: string) => http<{ note: Note }>(`/api/notes/${id}/undelete`, { method: 'POST' }),
  versions: (noteId: string) => http<{ versions: NoteVersionMeta[] }>(`/api/notes/${noteId}/versions`),
  version: (noteId: string, vid: number) => http<{ version: NoteVersion }>(`/api/notes/${noteId}/versions/${vid}`),
  snapshot: (noteId: string, label?: string) => http<{ version: NoteVersionMeta }>(`/api/notes/${noteId}/versions`, json('POST', { label })),
  restore: (noteId: string, vid: number) => http<{ note: Note }>(`/api/notes/${noteId}/restore/${vid}`, { method: 'POST' }),
  unlinkedMentions: (noteId: string) => http<{ notes: NoteLite[] }>(`/api/notes/${noteId}/unlinked-mentions`),
  exportUrl: (noteId: string, format = 'markdown') => `/api/notes/${noteId}/export?format=${format}`,

  // search
  search: (q: string, limit = 20) => http<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  searchTitles: (q: string, limit = 10) => http<{ results: TitleResult[] }>(`/api/search/titles?q=${encodeURIComponent(q)}&limit=${limit}`),

  // tags + dashboard
  tags: () => http<{ tags: Array<{ tag: string; count: number }> }>('/api/tags'),
  /** Rename across every note. Renaming onto an existing tag merges into it. */
  renameTag: (tag: string, next: string) =>
    http<{ ok: true; tag: string; updated: number }>(`/api/tags/${encodeURIComponent(tag)}`, json('PATCH', { tag: next })),
  /** Strip a tag from every note (the notes themselves are untouched). */
  deleteTag: (tag: string) =>
    http<{ ok: true; tag: string; updated: number }>(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),
  mergeTags: (from: string[], into: string) =>
    http<{ ok: true; tag: string; merged: string[]; updated: number }>('/api/tags/merge', json('POST', { from, into })),
  dashboard: () => http<DashboardData>('/api/dashboard'),

  // AI
  aiImprove: (b: { noteId?: string; text?: string; instruction?: string }) => http<{ markdown: string; model: string }>('/api/ai/improve', json('POST', b)),
  aiSummarize: (noteId: string) => http<{ markdown: string; model: string }>('/api/ai/summarize', json('POST', { noteId })),
  aiFlashcards: (noteId: string, count?: number) => http<{ cards: Flashcard[] }>('/api/ai/flashcards', json('POST', { noteId, count })),
  aiAsk: (question: string, notebookId?: string) => http<{ answer: string; sources: Array<{ id: string; title: string }>; model: string }>('/api/ai/ask', json('POST', { question, notebookId })),
  aiTitle: (noteId: string) => http<{ title: string }>('/api/ai/title', json('POST', { noteId })),
  aiClean: (noteId: string) => http<{ markdown: string; model: string }>('/api/ai/clean', json('POST', { noteId })),
  aiGaps: (noteId: string) =>
    http<{ markdown: string; model: string; sources: Array<{ name: string; kind: string }> }>('/api/ai/gaps', json('POST', { noteId })),
  aiHealth: () => http<{ ok: boolean; model?: string; error?: string }>('/api/meta/ai-health'),

  // import
  import: (form: FormData) => http<{ jobId: string }>('/api/import', { method: 'POST', body: form }),
  importJob: (id: string) => http<ImportJob>(`/api/import/jobs/${id}`),
  uploadImage: (form: FormData) => http<{ url: string }>('/api/import/image', { method: 'POST', body: form }),

  // study
  studyQueue: (limit = 20, notebookId?: string) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (notebookId) p.set('notebookId', notebookId);
    return http<{ cards: Flashcard[]; due: number; total: number }>(`/api/study/queue?${p}`);
  },
  studyCards: () => http<{ cards: Flashcard[] }>('/api/study/cards'),
  review: (cardId: string, rating: 'again' | 'hard' | 'good' | 'easy') => http<{ card: Flashcard; nextDueAt: string }>('/api/study/review', json('POST', { cardId, rating })),
  studyStats: () => http<StudyStats>('/api/study/stats'),
  updateCard: (id: string, b: Partial<{ question: string; answer: string; suspended: boolean }>) => http<{ card: Flashcard }>(`/api/study/cards/${id}`, json('PATCH', b)),
  deleteCard: (id: string) => http<{ ok: true }>(`/api/study/cards/${id}`, { method: 'DELETE' }),

  // templates (iteration 2)
  templates: () => http<{ templates: Template[] }>('/api/templates'),
  createTemplate: (b: { name: string; emoji?: string; description?: string; contentJson: unknown }) =>
    http<{ template: Template }>('/api/templates', json('POST', b)),
  deleteTemplate: (id: string) => http<{ ok: true }>(`/api/templates/${id}`, { method: 'DELETE' }),

  // comments (iteration 2)
  comments: (noteId: string) => http<{ comments: NoteComment[] }>(`/api/notes/${noteId}/comments`),
  addComment: (noteId: string, b: { anchorText?: string; body: string }) =>
    http<{ comment: NoteComment }>(`/api/notes/${noteId}/comments`, json('POST', b)),
  updateComment: (id: string, b: Partial<{ body: string; resolved: boolean }>) =>
    http<{ comment: NoteComment }>(`/api/comments/${id}`, json('PATCH', b)),
  deleteComment: (id: string) => http<{ ok: true }>(`/api/comments/${id}`, { method: 'DELETE' }),

  // manual flashcards (iteration 2)
  createCard: (b: { noteId?: string; question: string; answer: string }) =>
    http<{ card: Flashcard }>('/api/study/cards', json('POST', b)),

  // full search page (iteration 2) — same endpoint, optional parsed echo
  searchFull: (q: string, limit = 50) =>
    http<{ results: SearchResult[]; parsed?: SearchParsed }>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  // meta
  meta: () => http<MetaInfo>('/api/meta'),
  qr: (url?: string) => http<{ url: string; all: string[]; dataUrl: string }>(`/api/meta/qr${url ? `?url=${encodeURIComponent(url)}` : ''}`),
};

export type Api = typeof api;
export type { NotebookLite };
