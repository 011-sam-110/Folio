// Shared API types - mirror of docs/API.md. Do not drift from the contract.

/** The signed-in account, as returned by every /api/auth endpoint that yields a user.
 *  Deliberately has no token field: the session lives in an httpOnly cookie the
 *  browser attaches itself, so JS never sees or stores credentials. */
export interface User {
  id: string;
  email: string;
  displayName: string;
}

/** A social sign-in provider the server reports as configured (GET /api/auth/providers).
 *  Only enabled providers are returned, so the client renders a button per entry. */
export interface AuthProviderInfo {
  id: string;
  label: string;
}

export interface NotebookLite {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

export interface Notebook extends NotebookLite {
  position: number;
  archived: boolean;
  noteCount: number;
  lastNoteAt: string | null;
}

/** 'doc' opens in the TipTap editor; 'canvas' opens in the infinite board. */
export type NoteKind = 'doc' | 'canvas';

export interface NoteLite {
  id: string;
  notebookId: string;
  title: string;
  kind: NoteKind;
  snippet: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
  createdAt: string;
  tags: string[];
  notebook: NotebookLite;
  wordCount: number;
}

export interface Attachment {
  id: string;
  kind: string; // photo | slides | transcript | image | file
  originalName: string;
  url: string; // /uploads/...
  mime: string;
  size: number;
  status: string;
  createdAt: string;
}

export interface Note {
  id: string;
  notebookId: string;
  title: string;
  kind: NoteKind;
  contentJson: Record<string, unknown>;
  contentText: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  notebook: NotebookLite;
  attachments?: Attachment[];
}

export interface NoteVersionMeta {
  id: number;
  cause: 'autosave' | 'manual' | 'ai' | 'restore' | 'import';
  label: string | null;
  createdAt: string;
  title: string;
  wordCount: number;
}

export interface NoteVersion extends Omit<NoteVersionMeta, 'wordCount'> {
  contentJson: Record<string, unknown>;
}

export interface SearchResult {
  note: NoteLite;
  snippetHtml: string;
  score: number;
}

export interface TitleResult {
  id: string;
  title: string;
  notebook: NotebookLite;
  updatedAt: string;
}

export interface DashboardData {
  recent: NoteLite[];
  pinned: NoteLite[];
  continueNote: NoteLite | null;
  stats: { notes: number; notebooks: number; words: number; flashcardsDue: number };
  weekActivity: Array<{ date: string; count: number }>;
  notebooks: Array<{ id: string; name: string; emoji: string; color: string; noteCount: number; lastNoteAt: string | null }>;
  /** Iteration 2: Mon-Sun grid of this week's activity per notebook. */
  weekGrid: Array<{ date: string; dayLabel: string; total: number; byNotebook: Array<{ id: string; emoji: string; color: string; count: number }> }>;
  /** Iteration 2: computed weekly review checklist. */
  weeklyReview: {
    notesEditedThisWeek: number;
    flashcardsDue: number;
    notesWithoutSummary: number;
    unresolvedComments: number;
    suggestions: string[];
  };
  /** Iteration 2: per-notebook "last time in X" recall cards with a mini self-test. */
  recall: Array<{
    notebook: NotebookLite;
    lastNote: NoteLite | null;
    daysSince: number | null;
    quiz: { cardId: string; question: string; answer: string } | null;
  }>;
}

export interface Template {
  id: string;
  name: string;
  emoji: string;
  description: string;
  contentJson: Record<string, unknown>;
  builtin: boolean;
  createdAt: string;
}

export interface NoteComment {
  id: string;
  noteId: string;
  anchorText: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SearchParsed {
  terms: string[];
  phrases: string[];
  excluded: string[];
  /** Every `tag:` in the query - all must match. Was a single `tag` that ignored
   *  the second onwards, which contradicted what the Tags page promises. */
  tags: string[];
  /** Every `-tag:` - none may match. */
  excludedTags: string[];
  notebook: string | null;
}

export interface Flashcard {
  id: string;
  noteId: string | null;
  noteTitle?: string;
  notebookId?: string;
  notebookName?: string;
  question: string;
  answer: string;
  dueAt: string;
  reps: number;
  suspended?: boolean;
}

export interface StudyStats {
  due: number;
  total: number;
  reviewedToday: number;
  byNote: Array<{ noteId: string; noteTitle: string; total: number; due: number }>;
}

export interface ImportJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  step?: string;
  noteId?: string;
  /** Title of the note produced. Carried on the job so /capture never has to read the note
   *  itself - a QR-paired phone is not granted note-read access. */
  noteTitle?: string;
  error?: string;
  attachmentId?: string;
}

/**
 * What the current session may do. 'capture' is a phone paired by scanning the QR: same
 * account, but the server admits it only to listing notebooks and running one import.
 */
export type SessionScope = 'full' | 'capture';

/** Response of GET /api/meta/qr. `url` is the exact string encoded in `dataUrl`. */
export interface QrCode {
  /** Absolute `<base>/capture?pair=<code>` URL - what the QR encodes and what is displayed. */
  url: string;
  /** The origin `url` was built on, without the path or code. Safe to show. */
  base: string;
  /** ISO timestamp after which the embedded pairing code stops working. */
  expiresAt: string;
  ttlMs: number;
  /** Other LAN addresses this server has, for local dev when the first guess is wrong. */
  lanAddresses: string[];
  all: string[];
  dataUrl: string;
}

// --- Canvas boards + stylus ink -------------------------------------------------

/** Only these five are authored by the UI. The server's column also allows
 *  'ink' and 'embed'; we deliberately do not create them (see canvas/README note
 *  in CanvasBoard.tsx) - ink lives in note_ink so it can also overlay doc notes. */
export type CanvasItemKind = 'sticky' | 'text' | 'image' | 'shape' | 'link';

/** Kind-specific payload stored in canvas_items.data (an opaque JSON blob to the
 *  server, so every field here is optional and must be read defensively). */
export interface CanvasItemData {
  /** sticky | text */
  text?: string;
  /** sticky background / shape stroke+fill, as a token-independent hex. */
  color?: string;
  /** shape */
  shape?: 'rect' | 'ellipse' | 'arrow';
  /** image */
  url?: string;
  /** link - the referenced note, plus a cached title so the card renders before
   *  (or without) a fetch. The title is refreshed opportunistically on load. */
  noteId?: string;
  title?: string;
}

export interface CanvasItem {
  id: string;
  kind: CanvasItemKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  data: CanvasItemData;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  style: string; // arrow | line | dashed
}

export type InkTool = 'pen' | 'highlighter' | 'eraser';

/** A point as persisted: [x, y, pressure] in the layer's own coordinate space -
 *  world coordinates on a board, document coordinates on a doc-note overlay.
 *  A tuple (not an object) because a long stroke is thousands of these and the
 *  JSON size difference is roughly 3x. */
export type InkPoint = [number, number, number];

export interface InkStroke {
  id: string;
  points: InkPoint[];
  color: string;
  width: number;
  tool: 'pen' | 'highlighter';
}

export interface MetaInfo {
  name: string;
  version: string;
  port: number;
  ai: { configured: boolean; baseUrl: string; textModels: string[] };
  lan: { urls: string[] };
}

// --- Sharing / guest collaboration ---------------------------------------------

export type SharePermission = 'view' | 'edit';

/** A share link as the OWNER sees it. Deliberately has no token field: the raw
 *  token is returned exactly once, by createShare, and only its hash is stored -
 *  so a link listed here can be revoked but never re-read. */
export interface ShareLink {
  id: string;
  permission: SharePermission;
  hasPassword: boolean;
  expiresAt: string | null;
  createdAt: string;
}

/** The one-time result of minting a link. `token` exists nowhere else, ever. */
export interface ShareCreated {
  share: Omit<ShareLink, 'createdAt'>;
  token: string;
  /** Server-supplied path, e.g. `/join/<token>`. */
  url: string;
}

/** What a visitor is told BEFORE they clear the gate - title only, no content. */
export interface SharePeek {
  title: string;
  kind: NoteKind;
  permission: SharePermission;
  needsPassword: boolean;
}

export interface ShareGuest {
  displayName: string;
  color: string;
}

export interface SharedNote {
  note: { id: string; title: string; contentJson: Record<string, unknown>; kind: NoteKind; updatedAt: string };
  canEdit: boolean;
  /** Display name of whoever is asking - not an id, so it cannot identify actors. */
  you: string;
  revision: number;
}

/** One entry from the delta feed. `actor` is a user id or an opaque guest id. */
export interface ShareEvent {
  seq: number;
  kind: 'doc' | 'ink' | 'item' | 'edge' | 'presence' | string;
  payload: Record<string, unknown>;
  actor: string;
  at: string;
}

export interface ShareEvents {
  events: ShareEvent[];
  revision: number;
  presence: Array<{ name: string; color: string }>;
}

/** One dimension of the shared-pool AI allowance. */
export interface AiQuotaState {
  scope: 'user' | 'ip';
  used: number;
  limit: number;
  remaining: number;
}

/**
 * AI allowance and key status for the signed-in user. `usingOwnKey` makes the two
 * quota fields irrelevant: a personal key is billed to its owner and is not metered.
 */
export interface AiUsage {
  usingOwnKey: boolean;
  keyHint: string;
  baseUrl: string | null;
  /** Model names pinned for a personal key. Empty means the app's default chain. */
  models: string[];
  user: AiQuotaState;
  ip: AiQuotaState;
  resetAt: string;
}

/**
 * Whether AI would actually work for THIS user, and why not when it would not.
 *
 * `source` says which credential the answer describes - the shared pool the operator funds,
 * or the user's own saved key. `reason` separates "nothing is configured" (someone has to
 * change a setting) from "the gateway did not answer" (retrying is reasonable), because a
 * single "AI is offline" collapses two problems with opposite fixes.
 */
export interface AiHealthInfo {
  ok: boolean;
  model?: string;
  error?: string;
  source?: 'shared-pool' | 'own-key';
  reason?: 'not_configured' | 'unreachable';
  hint?: string;
}

export interface AiKeyInfo {
  present: boolean;
  hint: string;
  baseUrl: string | null;
  models: string[];
  /** Live verdict for the credential that was just saved or removed. */
  health?: AiHealthInfo;
}

// --- Import old notes wizard (bulk staging) ------------------------------------
// Staging DTOs for the multi-file "Import old notes" flow. Nothing here is written into a real
// notebook until commit; see server/src/lib/importBatch.ts.

export interface ImportBatch {
  id: string;
  source: string;
  /** open | categorised | committing | committed | discarded */
  status: string;
  categoriser: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportItem {
  id: string;
  batchId: string;
  attachmentId: string | null;
  sourcePath: string | null;
  originalName: string;
  /** doc | photo */
  kind: string;
  title: string;
  /** First 2KB of the extracted plain text, for the read-only review preview. */
  preview: string;
  wordCount: number;
  sourceTags: string[];
  suggestedNotebookId: string | null;
  suggestedNotebookName: string | null;
  suggestedTags: string[];
  confidence: number;
  rationale: string | null;
  decidedNotebookId: string | null;
  decidedNotebookName: string | null;
  decidedTags: string[] | null;
  /** new | append */
  decidedMode: string;
  decidedTargetNoteId: string | null;
  /** pending | ready | categorised | accepted | rejected | committed | failed */
  status: string;
  noteId: string | null;
  error: string | null;
  imageUrl: string | null;
  createdAt: string;
}

export interface ImportSource {
  id: string;
  label: string;
  setup: 'none' | 'oauth' | 'coming-soon';
  available: boolean;
}

export interface ImportLabelSpace {
  notebooks: Array<{ id: string; name: string; emoji: string }>;
  tags: string[];
  /** notebookId -> term -> tf weight; feeds the client heuristic's similarity signal. */
  profiles: Record<string, Record<string, number>>;
  docFreq: Record<string, number>;
  notebookCount: number;
}

export interface ImportSuggestionInput {
  itemId: string;
  notebook: { kind: 'existing'; id: string } | { kind: 'new'; name: string; emoji?: string };
  tags: string[];
  title?: string;
  confidence: number;
  rationale?: string;
}

export interface ImportCommitResult {
  created: number;
  skipped: number;
  failed: number;
  createdNotebooks: Array<{ id: string; name: string }>;
  items: ImportItem[];
  /** committed once nothing is left to file; else back to categorised (resume the rest). */
  batchStatus: string;
}
