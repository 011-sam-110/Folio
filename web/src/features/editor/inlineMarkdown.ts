// Inline markdown for AI suggestions - the `before`/`after` of a single review card.
//
// This is deliberately NOT markdownToSafeHtml. That one is a block converter: it wraps its
// output in `<p>`, promotes `## ` to headings and turns `- ` into lists, all of which are
// exactly wrong for a suggestion that replaces a phrase *inside* an existing paragraph. A
// review card's `after` is a run of inline content going into an inline range, so it gets an
// inline parse and nothing else.
//
// WHY THIS EXISTS AT ALL. A model asked to clean up formatting answers in markdown, because
// markdown is how you write "make this bold" in text. Before this, both ends of the review
// treated that answer as literal characters: the card showed `**Dijkstra's algorithm**` with
// the asterisks visible, and approving it wrote the asterisks into the student's note. The
// feature was called "clean up formatting" and it was the one thing it could not do.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Underscores are never emphasis here.
 *
 * `__init__`, `snake_case` and `MAX_CHARS` all appear in a computer science student's notes,
 * and CommonMark reads the first two as emphasis. Getting that wrong is not a cosmetic
 * problem: the underscores would be *removed* from the text written into their note, and
 * nothing downstream would ever tell them. Asterisk emphasis carries no comparable everyday
 * meaning in prose, so it stays.
 *
 * Escaped rather than stripped, so the character survives the round trip and comes back out
 * as itself. U+E001 sits in the Private Use Area, one past markdown.ts's math placeholder,
 * and neither `marked` nor DOMPurify has any reason to touch it.
 */
const UNDERSCORE = '';

/**
 * Does this string actually contain inline markup, or is it prose that merely has an
 * asterisk in it?
 *
 * Every pattern here requires a MATCHED pair with something between them, because the cost
 * of a false positive is silent character loss in a student's note and the cost of a false
 * negative is only that the suggestion applies as plain text, which is what it did before.
 * When in doubt this returns false.
 */
export function hasInlineMarkup(md: string): boolean {
  return (
    /\*\*[^*\n]+\*\*/.test(md) || // bold
    /(?<!\w)\*[^*\s][^*\n]*\*(?!\w)/.test(md) || // emphasis, but not `2 * 3 * 4`
    /`[^`\n]+`/.test(md) || // code
    /~~[^~\n]+~~/.test(md) || // strikethrough
    /\[[^\]\n]+\]\([^)\s]+\)/.test(md) // link
  );
}

/**
 * Tags an inline suggestion is allowed to produce.
 *
 * An allowlist rather than DOMPurify's default profile: this HTML is parsed straight into
 * the document by `approveEdit`, so anything the schema would reject is dead weight and
 * anything block-level would make the replacement fail. `marked.parseInline` should not emit
 * anything outside this set anyway - the list is here so that a future markdown option, or a
 * model answer that smuggles raw HTML through, cannot widen what lands in a note.
 */
const ALLOWED_TAGS = ['strong', 'b', 'em', 'i', 'code', 's', 'del', 'a', 'br'];
const ALLOWED_ATTR = ['href', 'title'];

/** Inline markdown to sanitized inline HTML. Safe to hand to `dangerouslySetInnerHTML`. */
export function inlineMarkdownToSafeHtml(md: string | null | undefined): string {
  if (!md) return '';
  const guarded = md.replace(/_/g, UNDERSCORE);
  const raw = marked.parseInline(guarded, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR });
  return clean.replace(new RegExp(UNDERSCORE, 'g'), '_');
}

/**
 * The same string with its markup removed rather than rendered.
 *
 * Used where the text has to stay plain but the markers should not show: the fallback path
 * in `approveEdit` when the parse produces something the schema cannot hold, and anywhere a
 * suggestion is summarised in one line.
 */
export function inlineMarkdownToPlainText(md: string | null | undefined): string {
  if (!md) return '';
  const html = inlineMarkdownToSafeHtml(md);
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent ?? '';
}
