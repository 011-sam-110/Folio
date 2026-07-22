// The guided tour's script.
//
// Two rules govern everything in this file:
//
// 1. EVERY SELECTOR HERE EXISTS IN THE APP TODAY. They were read off the real
//    components, not invented. Where a component had no stable hook, a `data-tour`
//    attribute was added at the source rather than selecting on a class name that
//    is free to change, or on an aria-label that flips with state (the ink toggle
//    and share button both do that).
//
// 2. NO STEP MAY DEAD-END. Each declares what to do when its target is missing -
//    `skip` for steps that are *about* an element (pointing at nothing teaches
//    nothing), `center` for steps whose value is the explanation itself. Targets go
//    missing for ordinary reasons: AI affordances are hidden when the gateway is
//    down, the outline pane only exists above 1200px, and a user who declined the
//    example notebook has no seeded note to open.
//
// The tour DRIVES: it navigates to each surface itself rather than waiting for the
// user to perform ten actions correctly. A tour that can be failed gets abandoned;
// this one can only be finished or skipped.
import type { Placement } from '@floating-ui/dom';

/** Ids the tour needs to build routes. Null when the user declined the example seed. */
export interface TourTargets {
  notebookId: string | null;
  noteId: string | null;
  linkedNoteId: string | null;
  canvasId: string | null;
}

export interface TourStep {
  id: string;
  title: string;
  /** Kept as plain strings: this copy is also read aloud verbatim by the live
   *  region, and marked-up bodies announce badly. Emphasis is carried by `code`. */
  body: string;
  /** Literal keystrokes/labels rendered as <kbd> chips under the body. */
  code?: string[];
  /** Where the tour must be before this step can resolve. Null = wherever we are. */
  route?: (t: TourTargets) => string | null;
  /** Tried in order; first one that is on screen wins. */
  target?: string[];
  /** Narrow-viewport override. The sidebar is a closed drawer under 900px, so its
   *  steps point at the button that opens it instead of at an off-canvas element. */
  mobileTarget?: string[];
  /** What to do when nothing resolves. */
  fallback: 'skip' | 'center';
  placement?: Placement;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'notebooks',
    title: 'Notebooks hold your modules',
    body:
      'One notebook per module works well: Algorithms, Databases, whatever you are taking. Notes live inside them, and tags cut across them, so nothing is ever filed in only one place.',
    route: () => '/',
    target: ['[data-tour="notebooks"]'],
    mobileTarget: ['[data-tour="mobile-menu"]'],
    fallback: 'center',
    placement: 'right',
  },
  {
    id: 'editor',
    title: 'Write here',
    body:
      'This is a block editor, so every paragraph, heading and list is a block you can drag by its handle. It saves as you type. The chip above tells you when it last saved, and every save keeps a version you can restore.',
    route: (t) => (t.noteId ? `/note/${t.noteId}` : null),
    target: ['[data-testid="note-editor"]'],
    fallback: 'center',
    placement: 'top',
  },
  {
    id: 'slash',
    title: 'Slash commands',
    body:
      'Type a forward slash on an empty line to get headings, lists, tables, code blocks, callouts and columns without leaving the keyboard. Markdown shortcuts work too: hash-space makes a heading, dash-space makes a bullet.',
    code: ['/'],
    route: (t) => (t.noteId ? `/note/${t.noteId}` : null),
    target: ['[data-testid="note-editor"]'],
    fallback: 'center',
    placement: 'top',
  },
  {
    id: 'tags',
    title: 'Tag it two ways',
    body:
      'Add tags as chips up here, or just type a hashtag anywhere in the note body. Both feed the same vocabulary, and the Tags page can rename or merge one across every note at once.',
    code: ['#revision'],
    route: (t) => (t.noteId ? `/note/${t.noteId}` : null),
    target: ['[data-testid="tag-editor"]'],
    fallback: 'skip',
    placement: 'bottom',
  },
  {
    id: 'wikilinks',
    title: 'Link notes together',
    body:
      'Type two square brackets to link another note by name. Every note then lists what links to it down here, plus unlinked mentions: notes that name this one without linking it yet.',
    code: ['[['],
    // Deliberately the note that is linked TO, not the one doing the linking: the
    // backlinks panel on the linking note is empty, which would demonstrate the
    // opposite of the point. This one has a real inbound link to show.
    route: (t) => (t.linkedNoteId ? `/note/${t.linkedNoteId}` : t.noteId ? `/note/${t.noteId}` : null),
    target: ['[data-testid="backlinks-section"]'],
    fallback: 'skip',
    placement: 'top',
  },
  {
    id: 'flashcards',
    title: 'Turn a passage into flashcards',
    body:
      'Select any sentence in a note and a small toolbar appears. One button on it files that passage as a flashcard. Cards come back on a spaced repetition schedule, so the Study page only ever shows you what is actually due.',
    route: (t) => (t.noteId ? `/note/${t.noteId}` : null),
    target: ['[data-testid="note-editor"]'],
    fallback: 'center',
    placement: 'top',
  },
  {
    id: 'search',
    title: 'Search understands operators',
    body:
      'Full-text search across everything you have written, with operators to narrow it: tag-colon, notebook-colon, quotes for an exact phrase, and a leading minus to exclude a word.',
    code: ['tag:algorithms', '"exact phrase"', '-excluded'],
    route: () => '/search',
    target: ['[data-tour="search-box"]', '.sr-search-box'],
    fallback: 'center',
    placement: 'bottom',
  },
  {
    id: 'import',
    title: 'Import what you already have',
    body:
      'Slide decks, PDFs and photos of handwriting all come in as structured notes. So do lecture recordings. Unote pulls the slides out of the video and transcribes the audio in your browser, so the recording itself never leaves your machine.',
    route: (t) => (t.notebookId ? `/notebook/${t.notebookId}` : null),
    target: ['[data-tour="import"]', 'button[aria-label="Import notes"]'],
    fallback: 'center',
    placement: 'bottom',
  },
  {
    id: 'canvas',
    title: 'Or work on a canvas',
    body:
      'A note can be an infinite board instead of a document: sticky notes, shapes, arrows and cards that link back to real notes. Pick up a pen here and it draws. With a stylus, your palm resting on the screen is ignored.',
    route: (t) => (t.canvasId ? `/note/${t.canvasId}` : null),
    target: ['[data-tour="canvas-tools"]', '.cv-tools'],
    fallback: 'skip',
    placement: 'bottom',
  },
  {
    id: 'share',
    title: 'Share a link',
    body:
      'Publish any note or board behind a link that cannot be guessed, view-only or editable, with a password if you want one. Whoever you send it to can open it without making an account.',
    route: (t) => (t.canvasId ? `/note/${t.canvasId}` : t.noteId ? `/note/${t.noteId}` : null),
    target: ['[data-testid="share-open"]'],
    fallback: 'skip',
    placement: 'bottom',
  },
];

export const TOUR_LENGTH = TOUR_STEPS.length;
