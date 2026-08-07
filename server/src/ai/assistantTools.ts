// What the note assistant can DO, as opposed to what it can say.
//
// The AI panel used to be a row of buttons that called a fixed endpoint each, and a student
// who typed "can you tidy up the formatting in here" at it had nowhere to type. Now the
// panel is a conversation and this is the list the model chooses from: one request comes
// back either as prose to read or as a tool to run.
//
// The catalogue lives in one module because three things have to agree about it and would
// otherwise drift apart: the prompt that offers the tools to the model, the validator that
// decides whether what came back is a real tool call, and the client that knows how to run
// each one. Adding a tool means adding it here and nowhere else on this side of the wire.

export type AssistantToolId =
  | 'improve_writing'
  | 'clean_formatting'
  | 'find_missing_from_uploads'
  | 'generate_flashcards'
  | 'summarise_note'
  | 'suggest_title'
  | 'gap_report';

export interface AssistantTool {
  id: AssistantToolId;
  /** What the model reads when deciding. Written as the effect on the student's note, not as
   *  the endpoint it happens to call - the model is choosing an outcome. */
  describe: string;
  /** True when the tool compares the note against uploaded source material, and so has
   *  nothing to do on a note with no usable uploads. */
  needsUploads?: boolean;
}

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    id: 'improve_writing',
    describe:
      'Propose per-sentence improvements to the note (clarity, accuracy, grammar, structure) for the student to approve or reject one at a time. Nothing is written until they approve it. Use this for "improve/tidy/fix/rewrite/check my writing" and for questions about whether the note is any good.',
  },
  {
    id: 'clean_formatting',
    describe:
      'Propose formatting-only changes (headings, lists, code blocks, emphasis) that leave the student\'s wording alone, again as individually approvable suggestions. Use this when they ask about layout, structure, headings, bullets or "make this look better".',
  },
  {
    id: 'find_missing_from_uploads',
    describe:
      'Compare the note against the slides, photos or transcripts uploaded to it and propose insertions covering what the note left out. Use this when they ask what they missed, or to fill the note in from their sources.',
    needsUploads: true,
  },
  {
    id: 'generate_flashcards',
    describe:
      'Generate revision flashcards from the note into their deck. Takes an integer argument "count" between 1 and 20; default to 8 when they do not say. Use this for revision, testing themselves, quizzing, or flashcards/Anki-style requests.',
  },
  {
    id: 'summarise_note',
    describe:
      'Write a summary of the note, shown for the student to read and optionally insert. Use this for "summarise", "TL;DR", "what are the key points".',
  },
  {
    id: 'suggest_title',
    describe: 'Rename the note to a title drawn from its content. Use this only when they ask about the title or name.',
  },
  {
    id: 'gap_report',
    describe:
      'Report, as prose to read rather than as edits, what this note is missing compared to its uploaded sources and to standard coverage of the topic. Use this when they want to know what is missing without changing anything yet.',
  },
];

const BY_ID = new Map(ASSISTANT_TOOLS.map(t => [t.id, t]));

export function assistantTool(id: string): AssistantTool | undefined {
  return BY_ID.get(id as AssistantToolId);
}

/**
 * Flashcard count, clamped to the same 1..20 band `POST /api/ai/flashcards` enforces.
 *
 * The model is asked for an integer and will sometimes answer "8", 8.0, or nothing at all,
 * and none of those should be able to reach the deck as a request for zero cards or for four
 * hundred. Duplicated deliberately rather than imported: the flashcards route is the
 * authority for its own input and must keep validating what it is given, whoever sent it.
 */
export function clampCardCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 8;
  return Math.min(20, Math.max(1, Math.trunc(n)));
}
