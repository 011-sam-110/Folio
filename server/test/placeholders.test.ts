import { describe, expect, it } from 'vitest';
import { rewrite, toPgPlaceholders } from '../src/db.js';

/**
 * The `?` -> `$n` rewriter is the one piece of this codebase where being subtly
 * wrong produces silent data corruption rather than an error: miscount once and
 * every later parameter binds to the wrong column, with Postgres none the wiser.
 *
 * The three miscounts below were found by an adversarial security review. None
 * were exploitable — no query in the codebase contains a block comment, a
 * dollar-quoted string, or an E'' literal — but they were latent traps for the
 * next person to write one.
 */
describe('toPgPlaceholders', () => {
  it('numbers parameters in order', () => {
    expect(toPgPlaceholders('SELECT * FROM notes WHERE id = ? AND user_id = ?')).toBe(
      'SELECT * FROM notes WHERE id = $1 AND user_id = $2',
    );
  });

  it('ignores a question mark inside a single-quoted string', () => {
    const out = rewrite("SELECT ? , 'is this a ? literal' , ?");
    expect(out.count).toBe(2);
    expect(out.text).toBe("SELECT $1 , 'is this a ? literal' , $2");
  });

  it('handles doubled quotes as escapes, not string terminators', () => {
    const out = rewrite("SELECT ?, 'it''s ? fine', ?");
    expect(out.count).toBe(2);
  });

  it('ignores a question mark inside a line comment', () => {
    const out = rewrite('SELECT ?, -- what about ? here\n  ?');
    expect(out.count).toBe(2);
  });

  it('ignores a question mark inside a block comment', () => {
    // Previously produced 3 placeholders for 2 real parameters.
    const out = rewrite('SELECT ? /* is this a ? param */ , ?');
    expect(out.count).toBe(2);
    expect(out.text).toBe('SELECT $1 /* is this a ? param */ , $2');
  });

  it('ignores a question mark inside a dollar-quoted string', () => {
    const out = rewrite('SELECT ?, $$ literal ? here $$, ?');
    expect(out.count).toBe(2);
    expect(out.text).toContain('$$ literal ? here $$');
  });

  it('ignores a question mark inside a tagged dollar-quoted string', () => {
    const out = rewrite('SELECT ?, $tag$ a ? b $tag$, ?');
    expect(out.count).toBe(2);
  });

  it('handles E-escape strings without losing the trailing parameter', () => {
    // Previously the backslash-escaped quote ran the parser past the closing quote,
    // leaving the final ? unnumbered.
    const out = rewrite("SELECT ?, E'\\'' , ?");
    expect(out.count).toBe(2);
    expect(out.text).not.toContain('?');
  });

  it('leaves an unterminated block comment from swallowing the whole tail silently', () => {
    // Malformed SQL should not silently become a zero-parameter query that then
    // fails far away with a confusing error.
    const out = rewrite('SELECT ? /* never closed');
    expect(out.count).toBe(1);
  });
});
