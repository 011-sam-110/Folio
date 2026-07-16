// Shared API types — mirror of docs/API.md. Do not drift from the contract.

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

export interface NoteLite {
  id: string;
  notebookId: string;
  title: string;
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

export interface MetaInfo {
  name: string;
  version: string;
  port: number;
  ai: { configured: boolean; baseUrl: string; textModels: string[] };
  lan: { urls: string[] };
}
