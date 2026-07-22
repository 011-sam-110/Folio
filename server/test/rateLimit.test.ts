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
  // Mirror buildApp(): trust exactly one proxy hop. Without this the helper tests a
  // configuration the app never runs in, and `req.ip` stays the loopback socket address
  // for every request, so every caller collapses into one bucket.
  app.set('trust proxy', 1);
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

  it('ignores a forged leading hop of x-forwarded-for', async () => {
    /**
     * This previously asserted the opposite: that the limiter keyed on the LEFTMOST entry.
     * That entry is supplied by the client, so a security review showed the limits could be
     * walked past entirely by varying the header, taking the auth throttles (and the scrypt
     * CPU amplification they exist to prevent) with them.
     *
     * The trustworthy entry is the one the proxy in front of us appended, on the right.
     * Both requests below arrive through the same real hop, so varying the forged prefix
     * must NOT mint a fresh bucket.
     */
    const app = appWith({ limit: 1, windowMs: 60_000, enabled: true });
    expect((await request(app).post('/try').set('x-forwarded-for', '9.9.9.9, 70.0.0.1')).status).toBe(200);
    expect((await request(app).post('/try').set('x-forwarded-for', '8.8.8.8, 70.0.0.1')).status).toBe(429);
  });

  it('still separates genuinely different proxy hops', async () => {
    // The flip side of the test above: keying on the real hop must not collapse distinct
    // clients into one bucket, which would let one noisy address lock everyone else out.
    const app = appWith({ limit: 1, windowMs: 60_000, enabled: true });
    expect((await request(app).post('/try').set('x-forwarded-for', '9.9.9.9, 70.0.0.1')).status).toBe(200);
    expect((await request(app).post('/try').set('x-forwarded-for', '9.9.9.9, 70.0.0.2')).status).toBe(200);
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
