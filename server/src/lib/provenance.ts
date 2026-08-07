/**
 * Where a citation actually points.
 *
 * `POST /api/ai/gaps/edits` cites the upload each suggestion came out of, and a citation is
 * only worth showing if the student can act on it: "slide 14 of 31" sends them somewhere,
 * "it is in the slides" does not. Neither the note nor `attachments.extracted_text` can
 * supply that. extracted_text is the model-restructured version of the upload, and the
 * restructure pass is explicitly told to drop slide numbers, footers and course codes
 * (ai/prompts.ts `slidesRestructurePrompt`), so the position is gone before anything is
 * stored. The RAW extraction does carry it. This module is the shape that survives it: the
 * import writes provenance from the raw text, before the model ever sees it.
 *
 * Three shapes, because there are three honest answers, and the difference between them is
 * the whole point:
 *
 *  - `pages`      - a deck or a PDF. Per-slide/per-page text plus the true total, which is
 *                   what makes "of 31" a fact rather than a flourish.
 *  - `timestamps` - a transcript whose source actually carries times.
 *  - `none`       - we looked, and this source has no sub-position: a photo of one page, or
 *                   a transcript with no times in it. Deliberately NOT the same as a NULL
 *                   column, which means the upload predates this feature and was never
 *                   looked at. Both cite the file name; only one of them is a statement
 *                   about the file.
 *
 * Nothing here is derived at read time. Re-extracting a PDF inside an AI route to work out
 * what page something was on would be slow, would double the failure modes of a request that
 * already depends on a gateway, and would give a different answer than the import did if a
 * library ever changed.
 */

/** What a position is called to the student reading the citation. */
export type PageUnit = 'slide' | 'page';

/** Why a source has no sub-position. Recorded rather than inferred, so "we checked and there
 *  are no timestamps" is distinguishable from "this is a photo" in the data itself. */
export type NoPositionReason = 'photo' | 'no-pages' | 'no-timestamps';

export interface ProvenancePage {
  /** 1-based, and the number the student will see: `n` of `total`. */
  n: number;
  text: string;
}

export interface ProvenanceSegment {
  /** Seconds from the start of the recording. */
  start: number;
  /** Seconds, or null when the source gave no end and there is no later mark to imply one. */
  end: number | null;
  text: string;
}

export type Provenance =
  | { kind: 'pages'; unit: PageUnit; total: number; pages: ProvenancePage[] }
  | { kind: 'timestamps'; segments: ProvenanceSegment[] }
  | { kind: 'none'; reason: NoPositionReason };

/**
 * Bounds on what one upload can put in its row.
 *
 * The payload bytes are already stored in the same row, so provenance is the second copy of
 * a file's text and deserves a ceiling of its own. Per-fragment first (one pathological slide
 * of dumped prose should not crowd out the other thirty), then a total budget: once it is
 * spent, later fragments keep their NUMBER and lose their TEXT. Numbering has to stay true
 * even where the text was dropped, because `total` is what "slide 14 of 31" is checked
 * against - dropping trailing pages instead would turn a real citation into a rejected one.
 */
const FRAGMENT_TEXT_CHARS = 4_000;
const MAX_PROVENANCE_TEXT = 250_000;

/** A transcript needs more than one mark to be a timeline; one stray "12:30" in a document is
 *  not evidence of anything. */
const MIN_TIMESTAMP_MARKS = 2;

// ---------------------------------------------------------------------------
// Building it, at import time
// ---------------------------------------------------------------------------

/**
 * Per-page provenance from the extractor's page array.
 *
 * Blank pages are kept rather than filtered. A deck's slide 12 is slide 12 even when the
 * extractor found no text on it, and compacting the array would shift every number after it
 * by one - which is the precise failure this whole feature exists to prevent.
 */
export function pagesProvenance(unit: PageUnit, pages: string[]): Provenance {
  if (!pages.length) return { kind: 'none', reason: 'no-pages' };

  let budget = MAX_PROVENANCE_TEXT;
  const out: ProvenancePage[] = pages.map((raw, i) => {
    const capped = raw.trim().slice(0, FRAGMENT_TEXT_CHARS);
    const kept = budget > 0 ? capped.slice(0, budget) : '';
    budget -= kept.length;
    return { n: i + 1, text: kept };
  });
  return { kind: 'pages', unit, total: pages.length, pages: out };
}

/** hh:mm:ss(.mmm) / mm:ss(.mmm), as the source writes it. */
const CLOCK = String.raw`(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
/** A WebVTT/SRT cue line, which is the one form that states an end as well as a start. */
const CUE_LINE = new RegExp(String.raw`^\s*\[?(${CLOCK})\]?\s*-->\s*\[?(${CLOCK})\]?`);
/** A leading timestamp: `[00:24:10] text`, `(24:10) text`, `24:10 - Speaker: text`, or a bare
 *  `24:10` on its own line with the speech on the next (how most players export). */
const LEAD_LINE = new RegExp(String.raw`^\s*[\[(]?(${CLOCK})[\])]?\s*[-:|]?\s*(.*)$`);

/** `24:10` -> 1450. Two parts are mm:ss, three are hh:mm:ss - the convention every
 *  transcript exporter uses, and the one `formatClock` writes back out. */
function toSeconds(clock: string): number | null {
  const parts = clock.split(/[.,]/)[0].split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Timeline provenance from a transcript, or `null` when the text carries no timeline.
 *
 * Returning null rather than an empty timeline is the load-bearing part: a transcript with no
 * times in it must be recorded as `{kind:'none', reason:'no-timestamps'}` by the caller, so
 * the citation falls back to the file name. A student sent to "24:10" of a recording that has
 * no such marker is worse off than one sent to the file, because they will look.
 *
 * Two guards keep prose from being read as a timeline. There must be at least two marks, and
 * they must not run backwards: a real recording's timestamps only ever increase, while a
 * timetable ("09:15 lecture, 12:30 lunch") is a set of unrelated clock times that a citation
 * has no business pointing into.
 */
export function timelineProvenance(raw: string): Provenance | null {
  const marks: Array<{ start: number; end: number | null; lines: string[] }> = [];

  for (const line of raw.split(/\r?\n/)) {
    const cue = CUE_LINE.exec(line);
    const cueStart = cue ? toSeconds(cue[1]) : null;
    if (cueStart !== null) {
      marks.push({ start: cueStart, end: cue ? toSeconds(cue[2]) : null, lines: [] });
      continue;
    }
    const lead = LEAD_LINE.exec(line);
    const leadStart = lead ? toSeconds(lead[1]) : null;
    if (leadStart !== null) {
      const rest = (lead?.[2] ?? '').trim();
      marks.push({ start: leadStart, end: null, lines: rest ? [rest] : [] });
      continue;
    }
    // Anything before the first mark is a header (WEBVTT, a title block) and belongs to no
    // position, so it is dropped rather than attributed to the first segment.
    if (marks.length) marks[marks.length - 1].lines.push(line);
  }

  if (marks.length < MIN_TIMESTAMP_MARKS) return null;
  for (let i = 1; i < marks.length; i++) if (marks[i].start < marks[i - 1].start) return null;

  let budget = MAX_PROVENANCE_TEXT;
  const segments: ProvenanceSegment[] = marks.map((m, i) => {
    // An absent end is filled from where the next mark starts, which is what a timeline
    // means - not a guess about content. The last segment keeps a null end because nothing
    // in the source says when it stops.
    const next = marks[i + 1];
    const end = m.end ?? (next ? next.start : null);
    const capped = m.lines.join('\n').trim().slice(0, FRAGMENT_TEXT_CHARS);
    const kept = budget > 0 ? capped.slice(0, budget) : '';
    budget -= kept.length;
    return { start: m.start, end: end !== null && end > m.start ? end : null, text: kept };
  });

  return { kind: 'timestamps', segments };
}

// ---------------------------------------------------------------------------
// Storing and reading it back
// ---------------------------------------------------------------------------

export function serialiseProvenance(p: Provenance): string {
  return JSON.stringify(p);
}

/**
 * Read the column back, or `null` for anything unreadable.
 *
 * This app wrote the value, but the column outlives the code that wrote it: an older shape, a
 * half-written row, or a NULL from before the column existed all arrive here. Every one of
 * them means the same thing to the caller - no positions are known - and that answer is
 * already safe, so an unrecognised shape degrades to it instead of throwing inside an AI
 * request the user is waiting on.
 */
export function parseProvenance(raw: unknown): Provenance | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  if (v.kind === 'pages') {
    const unit = v.unit === 'slide' || v.unit === 'page' ? v.unit : null;
    const total = typeof v.total === 'number' && Number.isFinite(v.total) ? Math.trunc(v.total) : 0;
    if (!unit || total < 1 || !Array.isArray(v.pages)) return null;
    const pages: ProvenancePage[] = [];
    for (const p of v.pages) {
      if (!p || typeof p !== 'object') continue;
      const page = p as Record<string, unknown>;
      const n = typeof page.n === 'number' ? Math.trunc(page.n) : 0;
      if (n < 1) continue;
      pages.push({ n, text: typeof page.text === 'string' ? page.text : '' });
    }
    return { kind: 'pages', unit, total, pages };
  }

  if (v.kind === 'timestamps') {
    if (!Array.isArray(v.segments)) return null;
    const segments: ProvenanceSegment[] = [];
    for (const s of v.segments) {
      if (!s || typeof s !== 'object') continue;
      const seg = s as Record<string, unknown>;
      if (typeof seg.start !== 'number' || !Number.isFinite(seg.start)) continue;
      const end = typeof seg.end === 'number' && Number.isFinite(seg.end) ? seg.end : null;
      segments.push({ start: seg.start, end, text: typeof seg.text === 'string' ? seg.text : '' });
    }
    if (!segments.length) return null;
    return { kind: 'timestamps', segments };
  }

  if (v.kind === 'none') {
    const reason = v.reason;
    const known: NoPositionReason[] = ['photo', 'no-pages', 'no-timestamps'];
    return { kind: 'none', reason: known.includes(reason as NoPositionReason) ? (reason as NoPositionReason) : 'no-pages' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handing it to the model
// ---------------------------------------------------------------------------

/** Seconds as a student would read them back: `24:10`, or `1:24:10` past an hour. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The span one segment covers, as it appears in its tag and in a citation. */
function segmentRange(seg: ProvenanceSegment): string {
  // A plain hyphen, not an en dash: every prompt in this codebase forbids en/em dashes in
  // model-written text, and the model copies this string.
  return seg.end === null ? formatClock(seg.start) : `${formatClock(seg.start)}-${formatClock(seg.end)}`;
}

/**
 * The source as the gaps prompt should see it: its own text, cut into fragments and tagged
 * with the position each one sits at.
 *
 * This is what makes a precise citation possible at all. A model handed one undivided blob
 * can only invent a slide number; a model handed `[slide 14 of 31]` above the text it is
 * quoting is copying one. Falls back to the stored restructured text when there are no
 * positions, which is exactly what the route sent before this existed.
 */
export function sourceTextForPrompt(prov: Provenance | null, extractedText: string): string {
  if (!prov || prov.kind === 'none') return extractedText;

  const body =
    prov.kind === 'pages'
      ? prov.pages
          .filter(p => p.text)
          .map(p => `[${prov.unit} ${p.n} of ${prov.total}]\n${p.text}`)
          .join('\n\n')
      : prov.segments
          .filter(s => s.text)
          .map(s => `[${segmentRange(s)}]\n${s.text}`)
          .join('\n\n');

  // Every fragment being empty means the extractor produced structure but no words (a deck of
  // pictures, say). The restructured text is then the only material there is to compare
  // against, and sending nothing would report the note as complete for the wrong reason.
  return body || extractedText;
}

/**
 * What pointers this source can honestly support, stated to the model on the source tag.
 *
 * Deliberately part of the prompt rather than left implicit in the tagging: a source whose
 * answer is "none" has no fragments to notice the absence from, and that is exactly the
 * source a model is most likely to invent a slide number for.
 */
export function positionsSummary(prov: Provenance | null): string {
  if (!prov || prov.kind === 'none') return 'none';
  if (prov.kind === 'pages') return `${prov.unit} 1 to ${prov.unit} ${prov.total}`;
  const first = prov.segments[0];
  const last = prov.segments[prov.segments.length - 1];
  return `${formatClock(first.start)} to ${formatClock(last.end ?? last.start)}`;
}

// ---------------------------------------------------------------------------
// Checking what came back
// ---------------------------------------------------------------------------

/** "slide 14 of 31", "page 7", "slides 4-6", "p. 12" - every position a label claims. */
const PAGE_CLAIM =
  /\b(slides?|pages?|pp?)\.?\s*(\d{1,4})(?:\s*(?:of|\/)\s*(\d{1,4}))?(?:\s*(?:-|–|—|to|through)\s*(\d{1,4}))?/gi;
/** Any clock time in a label, whichever separator the model chose to join a range with. */
const CLOCK_CLAIM = /\b(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\b/g;

interface PageClaim {
  /** The position named, e.g. 14. */
  n: number;
  /** The total the label asserts ("of 31"), when it asserts one. */
  outOf: number | null;
  /** The end of a claimed range ("slides 4-6"). */
  through: number | null;
}

function pageClaims(label: string): PageClaim[] {
  return [...label.matchAll(PAGE_CLAIM)].map(m => ({
    n: Number(m[2]),
    outOf: m[3] ? Number(m[3]) : null,
    through: m[4] ? Number(m[4]) : null,
  }));
}

function clockClaims(label: string): number[] {
  return [...label.matchAll(CLOCK_CLAIM)]
    .map(m => toSeconds(m[0]))
    .filter((n): n is number => n !== null);
}

export type LabelCheck = { ok: true; label: string } | { ok: false; why: string };

/**
 * The label a citation is allowed to carry, checked against what the source actually has.
 *
 * Two different answers, for two different situations, and the asymmetry is deliberate:
 *
 *  - The source HAS positions. A label naming one that does not exist ("slide 14" of a
 *    six-page handout) is a claim the student will go and check, and find false. There is no
 *    honest repair - we do not know which slide was meant - so the suggestion is rejected.
 *    A label that names no position at all (a section heading) is left alone: it is
 *    unverifiable here, but it is also not a claim about a numbered position.
 *  - The source has NO positions, or predates this column. Nothing can be checked, so no
 *    position claim can be trusted, and the file name is substituted. It is the one pointer
 *    that is certainly true, and it costs the student only precision they were never going
 *    to get. The suggestion itself is still good, so it survives.
 *
 * Callers must trim the label to its display length BEFORE calling this. Checking first and
 * truncating after would let `slide 14 of 31` be cut down to `slide 14 of 3` - a label that
 * passed a check it no longer satisfies.
 */
export function resolveSourceLabel(prov: Provenance | null, label: string, sourceName: string): LabelCheck {
  const clean = label.trim();

  if (!prov || prov.kind === 'none') return { ok: true, label: sourceName };

  if (prov.kind === 'pages') {
    if (clockClaims(clean).length) return { ok: false, why: 'a timestamp cited against a source with no timeline' };
    for (const claim of pageClaims(clean)) {
      if (claim.outOf !== null && claim.outOf !== prov.total) {
        return { ok: false, why: `claims a total of ${claim.outOf}, but the source has ${prov.total}` };
      }
      for (const n of [claim.n, claim.through]) {
        if (n === null) continue;
        if (n < 1 || n > prov.total) return { ok: false, why: `cites ${prov.unit} ${n} of a ${prov.total}-${prov.unit} source` };
      }
      if (claim.through !== null && claim.through < claim.n) {
        return { ok: false, why: 'cites a range that runs backwards' };
      }
    }
    return { ok: true, label: clean };
  }

  if (pageClaims(clean).length) return { ok: false, why: 'a slide or page cited against a transcript' };
  const last = prov.segments[prov.segments.length - 1];
  const covered = last.end ?? last.start;
  for (const t of clockClaims(clean)) {
    // Bounds, not an exact match against a mark. A transcript marked every few seconds makes
    // an exact-match rule reject "24:10" for a segment that starts at 24:08, which is a
    // citation the student can follow perfectly well. A time past the end of the recording
    // is the claim that points nowhere, and that is what this catches.
    if (t > covered) return { ok: false, why: `cites ${formatClock(t)} of a recording that ends at ${formatClock(covered)}` };
  }
  return { ok: true, label: clean };
}
