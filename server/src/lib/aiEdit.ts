/**
 * The `AiEdit` contract and the gate everything a model returns has to pass.
 *
 * A client-side text diff can say WHAT changed but never WHY, so the rationale has to come
 * from the model, attached per edit. That makes `reason` load-bearing rather than
 * decorative, and it makes this file necessary: a completion is untrusted input, and the
 * review UI has no sensible way to render a suggestion that is missing one of its parts.
 *
 * Anchoring is by `blockId` - the TipTap `UniqueID` the editor already mints and persists on
 * every block. The note is serialised for the prompt with those ids attached and the model
 * echoes one back per edit. Every alternative anchor breaks under ordinary typing: searching
 * for the `before` text breaks when the phrase repeats, a character offset breaks when the
 * user types anything at all, and a block index breaks when a block is added above. A
 * `blockId` only breaks when that specific block is deleted, which is detectable.
 */

import { checkById } from './checks.js';

export interface AiEdit {
  id: string;
  /** TipTap UniqueID of the target block. */
  blockId: string;
  op: 'replace' | 'insert' | 'delete';
  /** '' for insert. */
  before: string;
  /** '' for delete. */
  after: string;
  /** Model-authored. REQUIRED, non-empty. */
  reason: string;
  /** A check id from the catalogue, e.g. 'accuracy.contradicts-note'. */
  checkId: string;
  /** Uploads only: which attachment this suggestion came out of. */
  source?: { attachmentId: string; label: string };
}

const OPS = new Set(['replace', 'insert', 'delete']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function blank(v: string): boolean {
  return v.trim() === '';
}

/**
 * Drops anything the model returned that we refuse to render.
 *
 * Every rule below exists because rendering the alternative is worse for the reader than
 * dropping the suggestion, and the count of drops is returned rather than swallowed so the
 * rail can say "3 suggestions were discarded" instead of quietly showing fewer cards than
 * the model produced:
 *
 * - blank `reason`      - the rail card would render empty, and a card with no rationale is
 *                         exactly the all-or-nothing diff this feature replaces.
 * - unknown `checkId`   - severity is a property of the check's family, so an unrecognised
 *                         check has no severity, and the rail sorts by severity. There is
 *                         nowhere honest to put it.
 * - blank `blockId`     - nothing to anchor the decoration to.
 * - replace/delete with blank `before` - nothing to match against the document.
 * - insert/replace with blank `after`  - approving it would visibly do nothing.
 *
 * `before` and `after` are stored untrimmed even though they are tested with trim: the
 * surrounding whitespace is part of what gets matched and inserted, so trimming it would
 * silently move the edit by a character.
 */
export function validateEdits(raw: unknown): { edits: AiEdit[]; rejected: number } {
  if (!Array.isArray(raw)) return { edits: [], rejected: 0 };

  const edits: AiEdit[] = [];
  const seenIds = new Set<string>();
  let rejected = 0;

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected++;
      continue;
    }
    const e = item as Record<string, unknown>;

    const op = str(e.op);
    // An op outside the three the plugin knows how to decorate is not a rejection rule of
    // its own so much as the precondition for the two that follow - `before`/`after` can
    // only be judged against a known op.
    if (!OPS.has(op)) {
      rejected++;
      continue;
    }

    const reason = str(e.reason).trim();
    const checkId = str(e.checkId);
    const blockId = str(e.blockId);
    const before = str(e.before);
    const after = str(e.after);

    if (blank(reason)) { rejected++; continue; }
    if (!checkById(checkId)) { rejected++; continue; }
    if (blank(blockId)) { rejected++; continue; }
    if ((op === 'replace' || op === 'delete') && blank(before)) { rejected++; continue; }
    if ((op === 'insert' || op === 'replace') && blank(after)) { rejected++; continue; }

    // The id is a handle the client uses to approve, deny and key `settled` by - it is ours,
    // not content, so a missing or repeated one is minted rather than costing the user a
    // real suggestion. A duplicate would be the worse bug of the two: approving one card
    // would settle another.
    let id = str(e.id).trim();
    if (!id || seenIds.has(id)) id = newEditId();
    seenIds.add(id);

    const source = parseSource(e.source);
    edits.push({
      id,
      blockId,
      op: op as AiEdit['op'],
      before,
      after,
      reason,
      checkId,
      ...(source ? { source } : {}),
    });
  }

  return { edits, rejected };
}

/**
 * A citation is dropped on its own when malformed, rather than taking the edit with it: the
 * suggestion is still renderable and still actionable without one. The route that REQUIRES a
 * citation (`/api/ai/gaps`) enforces that itself, because "every edit cites a source" is a
 * property of that endpoint, not of the edit shape.
 */
function parseSource(raw: unknown): { attachmentId: string; label: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const attachmentId = str(s.attachmentId).trim();
  const label = str(s.label).trim();
  if (!attachmentId || !label) return null;
  return { attachmentId, label };
}

/** Same alphabet and length as `newId` in db.ts, without importing the database module. */
function newEditId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (const b of crypto.getRandomValues(new Uint8Array(14))) id += alphabet[b % alphabet.length];
  return id;
}
