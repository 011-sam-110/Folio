import { describe, it, expect } from 'vitest';
import { FAMILIES, PRESETS, checkById, familyById } from '../src/lib/checks';

describe('check catalogue', () => {
  it('has 8 families totalling 56 checks', () => {
    expect(FAMILIES).toHaveLength(8);
    expect(FAMILIES.flatMap((f) => f.checks)).toHaveLength(56);
  });

  it('gives every check a unique id namespaced by its family', () => {
    const ids = FAMILIES.flatMap((f) => f.checks.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FAMILIES) {
      for (const c of f.checks) expect(c.id.startsWith(`${f.id}.`)).toBe(true);
    }
  });

  it('marks accuracy and missing-content critical, grammar minor', () => {
    expect(familyById('accuracy')?.severity).toBe('critical');
    expect(familyById('missing-content')?.severity).toBe('critical');
    expect(familyById('grammar')?.severity).toBe('minor');
  });

  it('only lets presets reference families that exist', () => {
    for (const p of PRESETS) {
      for (const fam of p.families) expect(familyById(fam)).toBeDefined();
    }
  });

  it('resolves a check back to its family', () => {
    expect(checkById('accuracy.contradicts-note')?.family.id).toBe('accuracy');
    expect(checkById('nope.nothing')).toBeUndefined();
  });

  it('offers a single-family cheap preset', () => {
    expect(PRESETS.find((p) => p.id === 'proofread')?.families).toEqual(['grammar']);
  });
});
