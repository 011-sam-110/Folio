/**
 * The AI review check catalogue: 56 checks in 8 families.
 *
 * This file is the single source of truth for both halves of the feature - the prompts the
 * suggestion route builds, and the picker the user toggles families in. The client fetches
 * it over `GET /api/ai/checks` rather than bundling its own copy, which is what makes
 * "the picker and the prompts cannot drift" structural rather than a convention: adding a
 * check needs no web deploy, and a check the picker offers is by construction a check the
 * server actually runs.
 *
 * The family is also the unit of execution. One model request per enabled family, issued in
 * parallel: six to eight related checks per prompt is inside what a model reads carefully,
 * whereas all 56 in one prompt buys shallow coverage of all 56. That is why the counts here
 * are deliberately uneven but small, and why a family is never split across requests.
 */

export type Severity = 'critical' | 'normal' | 'minor';

export interface Check {
  /** `<familyId>.<slug>`, e.g. `accuracy.contradicts-note`. */
  id: string;
  label: string;
}

export interface Family {
  id: string;
  label: string;
  severity: Severity;
  checks: Check[];
}

export interface Preset {
  id: string;
  label: string;
  /** Family ids, not check ids - a preset turns whole requests on and off. */
  families: string[];
}

/**
 * Severity is carried by the FAMILY, not by the individual check.
 *
 * The rail sorts by severity so that "this contradicts your Dijkstra note" cannot end up
 * buried under six capitalisation fixes. If severity were per check - or worse, chosen by
 * the model per suggestion - that ordering would be at the mercy of a generated field, and
 * a model that returned `critical` on every edit would flatten the ordering back into
 * document order and undo the whole point. Fixing it to the family makes the rank a
 * property of the catalogue, decided once here, and unforgeable by a completion.
 *
 * It also matches how a reader thinks about the checks: everything under Accuracy is
 * "your notes say something untrue", everything under Grammar is "a typo". There is no
 * grammar check that deserves to outrank an accuracy one.
 *
 * Check ids are a persisted contract, not display strings: the picker stores the user's
 * per-notebook selection under them in localStorage, and every `AiEdit` names one. Renaming
 * an id silently drops a saved selection, so add and deprecate rather than rename.
 */
export const FAMILIES: Family[] = [
  {
    id: 'accuracy',
    label: 'Accuracy',
    severity: 'critical',
    checks: [
      { id: 'accuracy.factual-error', label: 'Factual error' },
      { id: 'accuracy.contradicts-note', label: 'Contradicts another of your notes' },
      { id: 'accuracy.contradicts-itself', label: 'Contradicts itself' },
      { id: 'accuracy.wrong-term', label: 'Wrong term for the concept' },
      { id: 'accuracy.formula-error', label: 'Formula or equation error' },
      { id: 'accuracy.units', label: 'Units missing or inconsistent' },
      { id: 'accuracy.misattributed-source', label: 'Misattributed source' },
      { id: 'accuracy.outdated-claim', label: 'Superseded or outdated claim' },
    ],
  },
  {
    id: 'missing-content',
    label: 'Missing content',
    severity: 'critical',
    checks: [
      { id: 'missing-content.undefined-term', label: 'Term used but never defined' },
      { id: 'missing-content.no-worked-example', label: 'No worked example' },
      { id: 'missing-content.no-motivation', label: 'Missing the motivation' },
      { id: 'missing-content.edge-case', label: 'Edge case not covered' },
      { id: 'missing-content.dangling-reference', label: 'Dangling reference' },
      { id: 'missing-content.count-mismatch', label: 'Count mismatch' },
      { id: 'missing-content.unfinished-thought', label: 'Unfinished thought' },
      { id: 'missing-content.prerequisite-assumed', label: 'Prerequisite assumed' },
      { id: 'missing-content.no-complexity', label: 'No complexity or cost given' },
    ],
  },
  {
    id: 'explanation',
    label: 'Explanation',
    severity: 'normal',
    checks: [
      { id: 'explanation.circular-definition', label: 'Circular definition' },
      { id: 'explanation.jargon-before-intro', label: 'Jargon used before introduction' },
      { id: 'explanation.skipped-step', label: 'Skipped step' },
      { id: 'explanation.restates-not-explains', label: 'Restates rather than explains' },
      { id: 'explanation.analogy-breaks-down', label: 'Analogy that breaks down' },
      { id: 'explanation.no-instance', label: 'Abstract with no instance' },
      { id: 'explanation.key-point-buried', label: 'Key point buried at the end' },
    ],
  },
  {
    id: 'clarity',
    label: 'Clarity',
    severity: 'normal',
    checks: [
      { id: 'clarity.ambiguous-pronoun', label: 'Ambiguous "it"/"this"' },
      { id: 'clarity.sentence-too-long', label: 'Sentence too long to parse' },
      { id: 'clarity.stacked-qualifiers', label: 'Stacked qualifiers' },
      { id: 'clarity.vague-quantifier', label: 'Vague quantifier' },
      { id: 'clarity.passive-hides-actor', label: 'Passive voice hiding the actor' },
      { id: 'clarity.double-negative', label: 'Double negative' },
      { id: 'clarity.two-names-one-thing', label: 'Two names for one thing' },
    ],
  },
  {
    id: 'structure',
    label: 'Structure',
    severity: 'normal',
    checks: [
      { id: 'structure.heading-level-skipped', label: 'Heading level skipped' },
      { id: 'structure.wall-of-text', label: 'Wall of text' },
      { id: 'structure.section-out-of-order', label: 'Section out of order' },
      { id: 'structure.duplicated-section', label: 'Duplicated section' },
      { id: 'structure.empty-heading', label: 'Heading with nothing under it' },
      { id: 'structure.should-be-list', label: 'Should be a list' },
      { id: 'structure.should-be-table', label: 'Should be a table' },
      { id: 'structure.should-be-callout', label: 'Should be a callout' },
    ],
  },
  {
    id: 'visual-hierarchy',
    label: 'Visual hierarchy',
    severity: 'normal',
    checks: [
      { id: 'visual-hierarchy.nothing-emphasised', label: 'Nothing emphasised in a long passage' },
      { id: 'visual-hierarchy.over-highlighted', label: 'Over-highlighted' },
      { id: 'visual-hierarchy.inconsistent-emphasis', label: 'Inconsistent emphasis style' },
      { id: 'visual-hierarchy.code-not-in-block', label: 'Code not in a code block' },
      { id: 'visual-hierarchy.maths-not-in-block', label: 'Maths not in a maths block' },
      { id: 'visual-hierarchy.better-as-notation-block', label: 'Better as a chemistry/3D/sketch block' },
    ],
  },
  {
    id: 'grammar',
    label: 'Grammar',
    severity: 'minor',
    checks: [
      { id: 'grammar.spelling', label: 'Spelling' },
      { id: 'grammar.agreement-tense', label: 'Agreement and tense' },
      { id: 'grammar.punctuation', label: 'Punctuation' },
      { id: 'grammar.inconsistent-capitalisation', label: 'Inconsistent capitalisation' },
      { id: 'grammar.technical-term-typo', label: 'Typo in a technical term' },
      { id: 'grammar.mixed-spelling-variants', label: 'Mixed British and American spelling' },
    ],
  },
  {
    // The family a general-purpose writing assistant structurally cannot offer: every check
    // here needs the rest of the notebook, not just the open note.
    id: 'notebook-hygiene',
    label: 'Notebook hygiene',
    severity: 'normal',
    checks: [
      { id: 'notebook-hygiene.should-link-note', label: 'Should link to an existing note' },
      { id: 'notebook-hygiene.near-duplicate', label: 'Near-duplicate of another note' },
      { id: 'notebook-hygiene.missing-tag', label: 'Missing a tag its siblings have' },
      { id: 'notebook-hygiene.flashcard-worthy', label: 'Flashcard-worthy passage' },
      { id: 'notebook-hygiene.title-mismatch', label: "Title doesn't match content" },
    ],
  },
];

/**
 * Starting points, not modes: the selection stays adjustable afterwards and persists per
 * notebook. The count of families in a preset IS its price, because the run issues one
 * model request per family - `Proofread only` costs one request, `Everything` costs eight.
 */
export const PRESETS: Preset[] = [
  { id: 'lecture-notes', label: 'Lecture notes', families: ['accuracy', 'missing-content', 'structure', 'notebook-hygiene'] },
  { id: 'essay-draft', label: 'Essay draft', families: ['explanation', 'clarity', 'structure', 'grammar'] },
  { id: 'exam-revision', label: 'Exam revision', families: ['accuracy', 'missing-content', 'explanation'] },
  { id: 'proofread', label: 'Proofread only', families: ['grammar'] },
  // Derived rather than listed, so a ninth family joins `Everything` by existing rather
  // than by someone remembering to add it here.
  { id: 'everything', label: 'Everything', families: FAMILIES.map(f => f.id) },
];

const FAMILY_INDEX = new Map(FAMILIES.map(f => [f.id, f]));
const CHECK_INDEX = new Map(
  FAMILIES.flatMap(family => family.checks.map(check => [check.id, { check, family }] as const)),
);

export function familyById(id: string): Family | undefined {
  return FAMILY_INDEX.get(id);
}

/**
 * Resolve a check id back to its check and its family.
 *
 * `validateEdits` leans on the `undefined` case: a `checkId` the catalogue does not know is
 * a suggestion with no severity, and a suggestion with no severity cannot be placed in the
 * rail's ordering - so it is dropped rather than rendered somewhere arbitrary.
 */
export function checkById(id: string): { check: Check; family: Family } | undefined {
  return CHECK_INDEX.get(id);
}
