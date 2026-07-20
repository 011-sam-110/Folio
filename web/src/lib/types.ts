// Shared API types — mirror of docs/API.md. Do not drift from the contract.

/** The signed-in account, as returned by every /api/auth endpoint that yields a user.
 *  Deliberately has no token field: the session lives in an httpOnly cookie the
 *  browser attaches itself, so JS never sees or stores credentials. */
export interface User {
  id: string;
  email: string;
  displayName: string;
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
  /** Iteration 2: Mon–Sun grid of this week's activity per notebook. */
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
  tag: string | null;
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
  error?: string;
  attachmentId?: string;
}

// --- Canvas boards + stylus ink -------------------------------------------------

/** Only these five are authored by the UI. The server's column also allows
 *  'ink' and 'embed'; we deliberately do not create them (see canvas/README note
 *  in CanvasBoard.tsx) — ink lives in note_ink so it can also overlay doc notes. */
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
  /** link — the referenced note, plus a cached title so the card renders before
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

/** A point as persisted: [x, y, pressure] in the layer's own coordinate space —
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
