import type {
  AiKeyInfo, AiUsage, AuthProviderInfo,
  CanvasEdge, CanvasItem, CanvasItemData, CanvasItemKind,
  DashboardData, Flashcard, ImportJob, InkStroke, MetaInfo, Note, NoteKind, NoteLite, NotebookLite, Notebook,
  NoteComment, NoteVersion, NoteVersionMeta, SearchParsed, SearchResult, StudyStats,
  ShareCreated, ShareEvents, ShareGuest, ShareLink, SharePeek, SharePermission, SharedNote,
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
    //
    // /api/share/* is exempt for the same reason from the other direction: a guest
    // has no account at all, so "401, you haven't joined this link yet" is the
    // normal pre-join answer. Letting it reach the handler would drop a signed-in
    // OWNER's session state just because they opened one of their own links.
    if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/share/')) {
      unauthorizedHandler?.();
    }
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
  // Signup is the only time the recovery key is ever transmitted — the server keeps
  // just its hash, so if it isn't shown to the user here it is gone for good.
  signup: (b: { email: string; password: string; displayName?: string }) =>
    http<{ user: User; recoveryKey: string }>('/api/auth/signup', json('POST', b)),
  login: (b: { email: string; password: string }) => http<{ user: User }>('/api/auth/login', json('POST', b)),
  logout: () => http<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => http<{ user: User }>('/api/auth/me'),
  changePassword: (b: { currentPassword: string; newPassword: string }) =>
    http<{ ok: true }>('/api/auth/password', json('POST', b)),
  // Redeeming signs the user straight in and returns a replacement key, so the
  // account is never left without a way back in.
  recover: (b: { email: string; recoveryKey: string; newPassword: string }) =>
    http<{ user: User; recoveryKey: string }>('/api/auth/recover', json('POST', b)),
  regenerateRecoveryKey: (b: { password: string }) =>
    http<{ recoveryKey: string }>('/api/auth/recovery/regenerate', json('POST', b)),
  // Social sign-in: which providers are configured. Unauthenticated, and returns only
  // enabled ones, so the auth pages can render a button per entry and nothing when empty.
  authProviders: () => http<{ providers: AuthProviderInfo[] }>('/api/auth/providers'),

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
  createNote: (b: { notebookId: string; title?: string; contentJson?: unknown; contentText?: string; tags?: string[]; kind?: NoteKind }) =>
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
  aiUsage: () => http<AiUsage>('/api/ai/usage'),
  aiSaveKey: (apiKey: string, baseUrl?: string) =>
    http<AiKeyInfo>('/api/ai/key', json('PUT', { apiKey, baseUrl: baseUrl || undefined })),
  aiDeleteKey: () => http<AiKeyInfo>('/api/ai/key', { method: 'DELETE' }),

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

  // canvas boards — spatial children of a note with kind='canvas'.
  canvas: (noteId: string) => http<{ items: CanvasItem[]; edges: CanvasEdge[] }>(`/api/canvas/${noteId}`),
  createCanvasItem: (noteId: string, b: { kind: CanvasItemKind; x: number; y: number; width: number; height: number; data?: CanvasItemData }) =>
    http<{ item: CanvasItem }>(`/api/canvas/${noteId}/items`, json('POST', b)),
  /** BULK and atomic. Every drag/resize/z-order commit goes through here as ONE
   *  request — never one per item and never one per pointermove frame. */
  updateCanvasItems: (noteId: string, items: Array<{ id: string } & Partial<Omit<CanvasItem, 'id' | 'createdAt' | 'updatedAt'>>>) =>
    http<{ items: CanvasItem[] }>(`/api/canvas/${noteId}/items`, json('PATCH', { items })),
  deleteCanvasItem: (noteId: string, itemId: string) =>
    http<{ ok: true }>(`/api/canvas/${noteId}/items/${itemId}`, { method: 'DELETE' }),
  createCanvasEdge: (noteId: string, b: { from: string; to: string; label?: string; style?: string }) =>
    http<{ edge: CanvasEdge }>(`/api/canvas/${noteId}/edges`, json('POST', b)),
  deleteCanvasEdge: (noteId: string, edgeId: string) =>
    http<{ ok: true }>(`/api/canvas/${noteId}/edges/${edgeId}`, { method: 'DELETE' }),

  // ink — works on ANY note id, not just canvases, which is what lets the same
  // layer annotate a normal document note.
  ink: (noteId: string) => http<{ strokes: InkStroke[] }>(`/api/canvas/${noteId}/ink`),
  /** Append-only, and batched: one request per stroke-flush, never per point. */
  addInk: (noteId: string, strokes: Array<Omit<InkStroke, 'id'>>) =>
    http<{ ids: string[] }>(`/api/canvas/${noteId}/ink`, json('POST', { strokes })),
  deleteInk: (noteId: string, inkId: string) =>
    http<{ ok: true }>(`/api/canvas/${noteId}/ink/${inkId}`, { method: 'DELETE' }),
  clearInk: (noteId: string) =>
    http<{ ok: true; removed: number }>(`/api/canvas/${noteId}/ink`, { method: 'DELETE' }),

  // sharing — owner side. Requires an account and ownership of the note.
  shares: (noteId: string) => http<{ shares: ShareLink[] }>(`/api/notes/${noteId}/shares`),
  /** Mints a link. The `token` in the response is the ONLY time the raw token
   *  exists on this side of the wire — the server keeps a hash, so nothing can
   *  recover it later. Callers must show it before dropping it (see ShareDialog,
   *  and RecoveryKeyPanel for the same contract on recovery keys). */
  createShare: (noteId: string, b: { permission: SharePermission; password?: string; expiresAt?: string }) =>
    http<ShareCreated>(`/api/notes/${noteId}/shares`, json('POST', b)),
  revokeShare: (shareId: string) => http<{ ok: true }>(`/api/shares/${shareId}`, { method: 'DELETE' }),

  // sharing — guest side. No account: access is a per-share httpOnly cookie the
  // join call sets, so as with sessions no token is ever held in JS.
  sharePeek: (token: string) => http<SharePeek>(`/api/share/${token}`),
  shareJoin: (token: string, b: { password?: string; displayName?: string }) =>
    http<{ guest: ShareGuest; permission: SharePermission }>(`/api/share/${token}/join`, json('POST', b)),
  sharedNote: (token: string) => http<SharedNote>(`/api/share/${token}/note`),
  updateSharedNote: (token: string, b: { title?: string; contentJson?: unknown }) =>
    http<{ ok: true }>(`/api/share/${token}/note`, json('PATCH', b)),
  /** Delta feed. Serverless cannot hold a WebSocket, so collaboration polls this
   *  with the highest revision seen and gets only what is newer. */
  shareEvents: (token: string, since: number) =>
    http<ShareEvents>(`/api/share/${token}/events?since=${since}`),
  sharedInk: (token: string) => http<{ strokes: InkStroke[] }>(`/api/share/${token}/ink`),
  /** Append-only: the share API has no ink DELETE, which is why the shared board
   *  offers no eraser. */
  addSharedInk: (token: string, strokes: Array<Omit<InkStroke, 'id'>>) =>
    http<{ ids: string[] }>(`/api/share/${token}/ink`, json('POST', { strokes })),

  // meta
  meta: () => http<MetaInfo>('/api/meta'),
  qr: (url?: string) => http<{ url: string; all: string[]; dataUrl: string }>(`/api/meta/qr${url ? `?url=${encodeURIComponent(url)}` : ''}`),
};

export type Api = typeof api;
export type { NotebookLite };
