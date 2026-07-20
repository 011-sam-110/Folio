import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetDatabase, makeUser, closeDatabase, insertNotebook } from './helpers.js';

const app = buildApp();

beforeAll(async () => { await resetDatabase(); });
afterAll(async () => { await closeDatabase(); });

describe('smoke', () => {
  it('rejects an unauthenticated request', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app).get('/api/notebooks');
    expect(res.status).toBe(401);
  });

  it('authenticates via the helper agent', async () => {
    const u = await makeUser(app);
    await insertNotebook(u.id, { name: 'Alpha' });
    const res = await u.agent.get('/api/notebooks');
    expect(res.status).toBe(200);
    expect(res.body.notebooks).toHaveLength(1);
  });

  it('isolates users from each other', async () => {
    const a = await makeUser(app);
    const b = await makeUser(app);
    await insertNotebook(a.id, { name: 'Private' });
    const res = await b.agent.get('/api/notebooks');
    expect(res.status).toBe(200);
    expect(res.body.notebooks).toHaveLength(0);
  });
});
