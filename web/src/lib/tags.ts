// Tag vocabulary helpers shared by the note tag editor, the inline #hashtag
// decoration and the tags page.
//
// WHY lowercase normalisation: the server matches tags with a plain equality
// (`nt.tag = ?` in server/src/routes/search.ts's `tag:` operator, and the same in
// GET /api/notes?tag=), which is case-SENSITIVE. Without folding, "#Revision" and
// "#revision" become two unrelated tags that each match only half the notes, and
// `tag:revision` silently misses the capitalised ones. Folding at the only two
// places a tag can be authored (the chip editor and the #hashtag parser - both of
// which route through this file) keeps exactly one canonical spelling per tag, and
// matches the vocabulary that already exists in the database ("week1", "lecture").
import { api } from './api';

/** Long enough for "distributed-systems", short enough that a chip row stays readable. */
export const MAX_TAG_LENGTH = 32;

/** Anything outside unicode letters/digits and the three structural separators is dropped. */
const INVALID_CHARS = /[^\p{L}\p{N}_/-]+/gu;
const EDGE_SEPARATORS = /^[-_/]+|[-_/]+$/g;

/**
 * Inline #hashtag matcher.
 *
 * The lookbehind is what keeps this from firing inside words and URLs: a '#'
 * preceded by a letter, digit, '_', '/' or another '#' is not a tag, which rules
 * out "C#" mid-word, "https://x/#section" and "##heading". Requiring the first
 * character to be a LETTER rules out the very common "issue #3" / "#1" false
 * positives while still allowing "#week1".
 */
export const HASHTAG_RE = /(?<![\p{L}\p{N}_/#])#(\p{L}[\p{L}\p{N}_/-]*)/gu;

/**
 * Fold one user-authored string into the canonical tag spelling, or null if
 * nothing usable survives. Accepts "#Week 1", "week-1" and "  WEEK1 " alike.
 */
export function normalizeTag(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^#+/, '') // typing the '#' is natural - accept it and drop it
    .toLowerCase()
    .replace(/\s+/g, '-') // "week 1" is one tag the user mis-spaced, not a broken one
    .replace(INVALID_CHARS, '')
    .replace(EDGE_SEPARATORS, '');
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_TAG_LENGTH).replace(EDGE_SEPARATORS, '') || null;
}

/** Normalise a list, dropping empties and duplicates while preserving first-seen order. */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Every #hashtag written in a note's plain-text body, normalised and de-duplicated. */
export function extractHashtags(text: string): string[] {
  const out: string[] = [];
  // A fresh regex per call: HASHTAG_RE is /g and therefore stateful (lastIndex),
  // so sharing the module-level instance across calls would skip matches.
  const re = new RegExp(HASHTAG_RE.source, HASHTAG_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = normalizeTag(m[1]);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The set actually persisted for a note: explicit chips ∪ body hashtags. */
export function unionTags(explicit: readonly string[], fromBody: readonly string[]): string[] {
  return normalizeTags([...explicit, ...fromBody]);
}

export interface TagCount {
  tag: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Vocabulary cache
//
// The chip editor's autocomplete needs the whole tag vocabulary, and the editor
// remounts on every note navigation. Caching it module-level (with a short TTL)
// means opening ten notes in a row costs one request instead of ten, while still
// picking up tags created in another tab within the minute.
// ---------------------------------------------------------------------------

const VOCAB_TTL_MS = 60_000;

let cached: { at: number; tags: TagCount[] } | null = null;
let inflight: Promise<TagCount[]> | null = null;

export function loadTagVocabulary(): Promise<TagCount[]> {
  if (cached && Date.now() - cached.at < VOCAB_TTL_MS) return Promise.resolve(cached.tags);
  // De-duplicate concurrent callers (e.g. two editors mounting in the same tick).
  inflight ??= api
    .tags()
    .then((res) => {
      cached = { at: Date.now(), tags: res.tags };
      return res.tags;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drop the cache after anything that changes the vocabulary (a save, a rename, a merge). */
export function invalidateTagVocabulary(): void {
  cached = null;
}
