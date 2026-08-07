import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { FAMILIES, PRESETS, checkById, familyById } from '../src/lib/checks';
import { buildApp } from '../src/app.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();

let alice: TestUser;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  alice = await makeUser(app);
});

afterAll(async () => {
  await closeDatabase();
});

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

  it('serves the catalogue to the client', async () => {
    const res = await alice.agent.get('/api/ai/checks');
    expect(res.status).toBe(200);
    expect(res.body.families).toHaveLength(8);
    expect(res.body.presets.map((p: { id: string }) => p.id)).toContain('proofread');
  });
});
