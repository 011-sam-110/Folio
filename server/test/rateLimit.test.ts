import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit, _resetRateLimits } from '../src/auth/rateLimit.js';

/**
 * The limiter is disabled under test globally (the other suites sign in dozens of
 * times from one address), so these tests opt it back in explicitly with
 * `enabled: true`. Its behaviour is covered here rather than incidentally.
 */
function appWith(opts: Parameters<typeof rateLimit>[0]) {
  const app = express();
  app.use(express.json());
  app.post('/try', rateLimit(opts), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('rateLimit', () => {
  beforeEach(() => _resetRateLimits());

  it('allows requests up to the limit', async () => {
    const app = appWith({ limit: 3, windowMs: 60_000, enabled: true });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/try').set('x-forwarded-for', '1.2.3.4');
      expect(res.status).toBe(200);
    }
  });

  it('rejects past the limit with 429 and Retry-After', async () => {
    const app = appWith({ limit: 2, windowMs: 60_000, enabled: true });
    await request(app).post('/try').set('x-forwarded-for', '5.6.7.8');
    await request(app).post('/try').set('x-forwarded-for', '5.6.7.8');
    const res = await request(app).post('/try').set('x-forwarded-for', '5.6.7.8');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.error).toMatch(/too many/i);
  });

  it('counts each client separately', async () => {
    // One noisy address must not lock everyone else out of signing in.
    const app = appWith({ limit: 1, windowMs: 60_000, enabled: true });
    expect((await request(app).post('/try').set('x-forwarded-for', '10.0.0.1')).status).toBe(200);
    expect((await request(app).post('/try').set('x-forwarded-for', '10.0.0.1')).status).toBe(429);
    expect((await request(app).post('/try').set('x-forwarded-for', '10.0.0.2')).status).toBe(200);
  });

  it('takes the first hop of x-forwarded-for', async () => {
    // Vercel appends proxies; the client is the leftmost entry. Reading the last
    // would key every request to the same proxy and throttle the whole world at once.
    const app = appWith({ limit: 1, windowMs: 60_000, enabled: true });
    expect((await request(app).post('/try').set('x-forwarded-for', '9.9.9.9, 70.0.0.1')).status).toBe(200);
    expect((await request(app).post('/try').set('x-forwarded-for', '9.9.9.9, 70.0.0.2')).status).toBe(429);
  });

  it('lets the window expire', async () => {
    const app = appWith({ limit: 1, windowMs: 30, enabled: true });
    expect((await request(app).post('/try').set('x-forwarded-for', '11.0.0.1')).status).toBe(200);
    expect((await request(app).post('/try').set('x-forwarded-for', '11.0.0.1')).status).toBe(429);
    await new Promise((r) => setTimeout(r, 50));
    expect((await request(app).post('/try').set('x-forwarded-for', '11.0.0.1')).status).toBe(200);
  });

  it('is off by default under test so other suites are unaffected', async () => {
    const app = appWith({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/try').set('x-forwarded-for', '12.0.0.1')).status).toBe(200);
    }
  });
});
