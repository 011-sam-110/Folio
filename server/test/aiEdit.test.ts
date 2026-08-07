import { describe, it, expect } from 'vitest';
import { validateEdits } from '../src/lib/aiEdit';

const ok = {
  id: 'e1', blockId: 'b1', op: 'replace',
  before: 'a queue', after: 'a FIFO queue',
  reason: 'Your notes distinguish FIFO from priority queues.',
  checkId: 'clarity.two-names-one-thing',
};

describe('validateEdits', () => {
  it('keeps a well-formed edit', () => {
    const r = validateEdits([ok]);
    expect(r.edits).toHaveLength(1);
    expect(r.rejected).toBe(0);
  });

  it('rejects an edit with no reason', () => {
    const r = validateEdits([{ ...ok, reason: '   ' }]);
    expect(r.edits).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });

  it('rejects an unknown checkId', () => {
    expect(validateEdits([{ ...ok, checkId: 'made.up' }]).edits).toHaveLength(0);
  });

  it('rejects a replace with nothing to match on', () => {
    expect(validateEdits([{ ...ok, before: '' }]).edits).toHaveLength(0);
  });

  it('rejects an insert that inserts nothing', () => {
    expect(validateEdits([{ ...ok, op: 'insert', before: '', after: '' }]).edits).toHaveLength(0);
  });

  it('survives junk without throwing', () => {
    expect(validateEdits(null).edits).toEqual([]);
    expect(validateEdits([1, 'x', {}]).rejected).toBe(3);
  });
});
