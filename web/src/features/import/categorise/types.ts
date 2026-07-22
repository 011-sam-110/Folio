// The categoriser abstraction. One interface, interchangeable backends. Phase 1 ships the
// heuristic (zero-AI, runs here in the browser); the LLM and in-browser-embedding strategies
// slot in behind the same interface later. "AI down" only ever changes the quality of the
// first guess, never whether the import works.

export interface CategoriserItem {
  id: string;
  title: string;
  /** Extracted plain text. May be '' (e.g. a photo whose OCR found nothing). */
  text: string;
  filename: string;
  /** ['databases'] - the strongest sort signal a student ever gives us. */
  folderPath?: string[];
  /** Frontmatter / #hashtags found in the source. */
  sourceTags?: string[];
}

export interface NotebookLabel {
  id: string;
  name: string;
  emoji: string;
}

export interface LabelSpace {
  notebooks: NotebookLabel[];
  /** The user's existing tag vocabulary - we reinforce it rather than invent noise. */
  tags: string[];
  /** notebookId -> term -> tf weight (0..1). Precomputed server-side from the notebook's notes. */
  profiles?: Record<string, Record<string, number>>;
  /** term -> number of notebooks whose profile contains it (for IDF). */
  docFreq?: Record<string, number>;
  notebookCount?: number;
}

export interface CategoriserInput {
  items: CategoriserItem[];
  labelSpace: LabelSpace;
}

export type SuggestionNotebook =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string; emoji?: string };

export interface Suggestion {
  itemId: string;
  notebook: SuggestionNotebook;
  tags: string[];
  title?: string;
  /** 0..1, honest per strategy: folder match is high, keyword-only is low. */
  confidence: number;
  rationale?: string;
}

export interface Categoriser {
  readonly id: 'heuristic' | 'llm' | 'browser-embed';
  categorise(input: CategoriserInput): Promise<Suggestion[]>;
}

/** The single bucket everything unsorted falls into, so a loose pile never sprays into a
 *  dozen half-empty notebooks. */
export const UNSORTED = 'Unsorted';

export type ConfidenceBand = 'high' | 'med' | 'low';
export function confidenceBand(c: number): ConfidenceBand {
  if (c >= 0.66) return 'high';
  if (c >= 0.33) return 'med';
  return 'low';
}
