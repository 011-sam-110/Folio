// The client half of the assistant's tools: what each one is called, and what pressing its
// button says.
//
// The buttons are not a second way in. Pressing "Improve writing" types "Improve the writing
// in this note." into the conversation and sends it, exactly as if the student had; the model
// reads that message and picks the tool, the same as it would for "can you tidy this up a
// bit". So there is one path through the panel and one place a request can be understood,
// rather than a button wired straight to an endpoint beside a chat box that has to guess.
//
// The cost of that is one model call to route a press whose intent was never in doubt, and
// the cost of it going wrong is a student pressing a labelled button and getting a sentence
// back. `intent` is the insurance: the panel tells `runAssistantTool` which tool the press
// MEANT, and a press that routes to something else falls back to it. A typed message has no
// intent and no fallback, because there is nothing to fall back to.
import type { AiEdit } from '../../lib/types';

export interface QuickAction {
  /** Matches an id in server/src/ai/assistantTools.ts. */
  intent: string;
  label: string;
  /** Sent verbatim as the student's message. Written the way someone would actually ask. */
  message: string;
  /** Greyed out with this as the reason when the note has no usable uploads. */
  needsUploads?: boolean;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { intent: 'improve_writing', label: 'Improve writing', message: 'Improve the writing in this note.' },
  { intent: 'clean_formatting', label: 'Clean up formatting', message: 'Clean up the formatting in this note.' },
  {
    intent: 'find_missing_from_uploads',
    label: 'Find missing content from uploads',
    message: 'Find what this note is missing compared to the sources I uploaded, and suggest what to add.',
    needsUploads: true,
  },
  { intent: 'generate_flashcards', label: 'Generate flashcards', message: 'Make flashcards from this note.' },
];

/** How a tool is named in the conversation once it is running. Falls back to the raw id, so
 *  a server that knows a tool this build does not still reads as something rather than as a
 *  blank card. */
const TOOL_LABELS: Record<string, string> = {
  improve_writing: 'Improve writing',
  clean_formatting: 'Clean up formatting',
  find_missing_from_uploads: 'Find missing content from uploads',
  generate_flashcards: 'Generate flashcards',
  summarise_note: 'Summarise note',
  suggest_title: 'Suggest a title',
  gap_report: 'Check against sources',
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ');
}

/**
 * What running a tool produced, in the terms the conversation renders.
 *
 * Deliberately not the tools' own response shapes. The panel should not have to know that
 * suggestions come back as `AiSuggestResult` while a summary is a markdown blob and
 * flashcards are rows in a deck - it needs to know whether there is something to review,
 * something to read, or just something that happened.
 */
export type ToolOutcome =
  /** Suggestions are staged in the editor and the review renders under this turn. */
  | { kind: 'review'; count: number; edits: AiEdit[] }
  /** Prose the student can read and optionally insert (summary, gap report). */
  | { kind: 'prose'; markdown: string; sources?: string[] }
  /** Done, with nothing to review - flashcards written to the deck, title renamed. */
  | { kind: 'done'; message: string }
  /** Ran, found nothing to suggest. Distinct from an error, and worth saying out loud. */
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };
