// Phone capture: the QR's contents, and the pairing credential it carries.
//
// The bug this suite pins: /api/meta/qr built its URL from `os.networkInterfaces()`, so the
// QR encoded the address of the machine running the process. On Vercel that is the function
// container's private VPC address - `http://10.x.x.x:4780` - which no phone can open. It
// also encoded only the origin while the UI displayed origin + '/capture', and it handed the
// phone no credential at all for a page that sat behind the session guard.

import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { resetDatabase, resetData, makeUser, insertNotebook, closeDatabase, type TestUser } from './helpers.js';
import { splitAuthority, appPublicUrl, lanAddresses, normalisePort } from '../src/lib/publicUrl.js';
import { isCaptureAllowed } from '../src/auth/middleware.js';
import { createPairing, redeemPairing, pruneExpiredPairings } from '../src/auth/pairing.js';
import { COOKIE_NAME } from '../src/auth/session.js';
import request from 'supertest';
import type { Request } from 'express';

const app = buildApp();
let user: TestUser;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  user = await makeUser(app);
});

afterAll(async () => {
  await closeDatabase();
});

/** A stand-in for the parts of `Request` that appPublicUrl reads. */
function fakeReq(headers: Record<string, string>, protocol = 'https'): Request {
  return {
    protocol,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

/** Decode a QR data URL back to the string it encodes - what a phone's camera would see. */
async function decodeQr(dataUrl: string): Promise<string> {
  const { Jimp } = await import('jimp');
  const jsQR = (await import('jsqr')).default;
  const img = await Jimp.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(img.bitmap.data), img.bitmap.width, img.bitmap.height);
  if (!decoded) throw new Error('QR did not decode');
  return decoded.data;
}

describe('public URL derivation', () => {
  it('parses a Host authority, including IPv6 literals and no-port forms', () => {
    expect(splitAuthority('unote-six.vercel.app')).toEqual({ hostname: 'unote-six.vercel.app', port: '' });
    expect(splitAuthority('localhost:5199')).toEqual({ hostname: 'localhost', port: '5199' });
    expect(splitAuthority('[::1]:4780')).toEqual({ hostname: '[::1]', port: '4780' });
    expect(splitAuthority('')).toBeNull();
    // A hostname carrying anything that would break out of the URL is not a hostname.
    expect(splitAuthority('evil.com/path')).toBeNull();
    expect(splitAuthority('evil.com" onload="x')).toBeNull();
  });

  it('uses the origin the browser actually reached, not the container address', () => {
    const url = appPublicUrl(fakeReq({ host: 'unote-six.vercel.app' }));
    expect(url).toBe('https://unote-six.vercel.app');
    // The regression in one line: never a private address, never the API port.
    expect(url).not.toMatch(/^http:\/\/(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./);
  });

  it('prefers X-Forwarded-Host, and takes only the client-facing hop', () => {
    expect(
      appPublicUrl(fakeReq({ host: 'internal.vercel.internal', 'x-forwarded-host': 'unote-six.vercel.app, proxy.internal' })),
    ).toBe('https://unote-six.vercel.app');
  });

  /**
   * The production path, which is where the bug actually lived. IS_SERVERLESS is read from
   * `process.env.VERCEL` when config.ts is first imported, so this branch is only reachable
   * by re-importing the module with the deployed environment in place - and it is worth the
   * trouble, because it is the only branch unote-six.vercel.app ever executes.
   */
  describe('on Vercel', () => {
    async function loadServerless(env: Record<string, string> = {}) {
      vi.resetModules();
      vi.stubEnv('VERCEL', '1');
      vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'unote-six.vercel.app');
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      return import('../src/lib/publicUrl.js');
    }

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('emits the production https origin', async () => {
      const { appPublicUrl: fn } = await loadServerless();
      expect(fn(fakeReq({ host: 'unote-six.vercel.app' }))).toBe('https://unote-six.vercel.app');
    });

    it('forces https even when X-Forwarded-Proto is missing', async () => {
      const { appPublicUrl: fn } = await loadServerless();
      // A pairing code must never ride an http:// URL, not even one that would redirect.
      expect(fn(fakeReq({ host: 'unote-six.vercel.app' }, 'http'))).toBe('https://unote-six.vercel.app');
    });

    it('REFUSES a forged Host and falls back to the known production origin', async () => {
      const { appPublicUrl: fn } = await loadServerless();
      // Otherwise a Host/X-Forwarded-Host injection puts an attacker's domain in a QR that
      // carries a live pairing code - the user scans it and hands their capture session away.
      expect(fn(fakeReq({ host: 'attacker.example.com' }))).toBe('https://unote-six.vercel.app');
      expect(fn(fakeReq({ host: 'x', 'x-forwarded-host': 'attacker.example.com' }))).toBe(
        'https://unote-six.vercel.app',
      );
    });

    it('accepts a preview deployment hostname', async () => {
      const { appPublicUrl: fn } = await loadServerless({ VERCEL_URL: 'unote-git-branch-sam.vercel.app' });
      expect(fn(fakeReq({ host: 'unote-git-branch-sam.vercel.app' }))).toBe(
        'https://unote-git-branch-sam.vercel.app',
      );
    });

    it('accepts a custom domain listed in FOLIO_CORS_ORIGINS', async () => {
      const { appPublicUrl: fn } = await loadServerless({ FOLIO_CORS_ORIGINS: 'https://notes.example.com' });
      expect(fn(fakeReq({ host: 'notes.example.com' }))).toBe('https://notes.example.com');
    });

    it('never falls back to a LAN address', async () => {
      const { appPublicUrl: fn } = await loadServerless();
      // The original failure: os.networkInterfaces() on a Lambda yields the container's own
      // private VPC address, which was then encoded into the QR.
      expect(fn(fakeReq({ host: 'attacker.example.com' }))).not.toMatch(
        /\/\/(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./,
      );
    });
  });

  it('honours FOLIO_PUBLIC_URL above everything, trailing slash stripped', () => {
    process.env.FOLIO_PUBLIC_URL = 'https://notes.example.com/';
    try {
      expect(appPublicUrl(fakeReq({ host: 'whatever.example' }))).toBe('https://notes.example.com');
    } finally {
      delete process.env.FOLIO_PUBLIC_URL;
    }
  });

  it('swaps loopback for a LAN address but KEEPS the port the browser is using', () => {
    // Local dev: the browser is on Vite (5199), which proxies /api to Express. The phone
    // needs Vite's port on a routable address - the API port would not serve the SPA.
    const url = appPublicUrl(fakeReq({ host: 'localhost:5199' }, 'http'));
    expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:5199$/);
    expect(url).not.toContain('localhost');
  });

  it('leaves a non-loopback local host alone', () => {
    expect(appPublicUrl(fakeReq({ host: '192.168.1.50:5199' }, 'http'))).toBe('http://192.168.1.50:5199');
  });

  it('lets the browser supply the port that is actually serving the page', () => {
    // Vite rewrites Host on its /api proxy, so the request claims the API port (4780) even
    // though the SPA is on 5199. Without this the QR points at a port that only serves the
    // app when web/dist has been built.
    expect(appPublicUrl(fakeReq({ host: 'localhost:4780' }, 'http'), '5199')).toMatch(/:5199$/);
  });

  it('accepts a port but never a host from the client', () => {
    expect(normalisePort('5199')).toBe('5199');
    expect(normalisePort('1')).toBe('1');
    expect(normalisePort('65535')).toBe('65535');
    for (const bad of ['0', '65536', '99999', '-1', '80abc', 'evil.com', '', undefined, '5199:evil']) {
      expect(normalisePort(bad as string | undefined), String(bad)).toBe('');
    }
    // A rejected port must not leak into the URL in any form.
    const url = appPublicUrl(fakeReq({ host: 'localhost:4780' }, 'http'), 'evil.com');
    expect(url).not.toContain('evil.com');
    expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:4780$/);
  });

  it('ranks a real Wi-Fi address ahead of virtual adapters', () => {
    const addresses = lanAddresses();
    if (addresses.length < 2) return; // single-NIC CI box: nothing to rank
    const first = addresses[0];
    // The original bug on the reporting machine: [0] was the WSL vEthernet adapter.
    expect(first).not.toMatch(/^192\.168\.(56|91|136|137)\./);
  });
});

/**
 * These drive the real Express app over supertest, which speaks plain HTTP - so the scheme
 * here is http, exactly as it would be for a self-hosted run. The https-on-Vercel guarantee
 * is asserted in the 'on Vercel' block above, which is the branch production takes.
 */
describe('GET /api/meta/qr', () => {
  it('encodes an absolute, routable /capture URL carrying a pairing code', async () => {
    const res = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    expect(res.status).toBe(200);

    const url = new URL(res.body.url);
    expect(url.hostname).toBe('unote-six.vercel.app');
    expect(url.pathname).toBe('/capture');
    expect(url.searchParams.get('pair')).toBeTruthy();

    // The QR image and the string the UI shows must be the same thing. They were not: the
    // QR held the bare origin while the modal printed origin + '/capture'.
    expect(await decodeQr(res.body.dataUrl)).toBe(res.body.url);
  });

  it('never encodes a private, loopback or portless-API address for a hosted host', async () => {
    const res = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    expect(res.body.url).not.toMatch(/localhost|127\.0\.0\.1|:4780/);
    expect(res.body.url).not.toMatch(/\/\/(10|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./);
  });

  it('reports an expiry and does not leak the code into `base`', async () => {
    const res = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.base).toBe('http://unote-six.vercel.app');
    expect(res.body.base).not.toContain('pair=');
  });

  it('issues a DIFFERENT code each time', async () => {
    const a = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    const b = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    expect(a.body.url).not.toBe(b.body.url);
  });

  it('ignores a caller-supplied LAN address that is not one of this machine\'s own', async () => {
    const res = await user.agent.get('/api/meta/qr?lan=evil.example.com').set('Host', 'unote-six.vercel.app');
    expect(res.body.base).toBe('http://unote-six.vercel.app');
    expect(res.body.url).not.toContain('evil.example.com');
  });

  it('requires a session', async () => {
    const res = await request(app).get('/api/meta/qr');
    expect(res.status).toBe(401);
  });
});

describe('pairing codes', () => {
  it('redeems exactly once', async () => {
    const { token } = await createPairing(user.id);
    expect(await redeemPairing(token)).toBe(user.id);
    // A photograph of the QR is worthless after the intended phone has used it.
    expect(await redeemPairing(token)).toBeNull();
  });

  it('refuses an unknown or expired code', async () => {
    expect(await redeemPairing('not-a-real-token')).toBeNull();
    expect(await redeemPairing('')).toBeNull();

    const { token } = await createPairing(user.id);
    await db
      .prepare('UPDATE capture_pairings SET expires_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), user.id);
    expect(await redeemPairing(token)).toBeNull();
  });

  it('stores the code hashed, never in the clear', async () => {
    const { token } = await createPairing(user.id);
    const rows = await db.prepare('SELECT token_hash FROM capture_pairings').all<{ token_hash: string }>();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prunes expired rows', async () => {
    await createPairing(user.id);
    await db.prepare('UPDATE capture_pairings SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(await pruneExpiredPairings()).toBe(1);
  });
});

describe('POST /api/auth/pair', () => {
  it('turns a code into a working session on a device with no cookie', async () => {
    const qr = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    const token = new URL(qr.body.url).searchParams.get('pair')!;

    // A brand-new agent - the phone, which has never signed in.
    const phone = request.agent(app);
    expect((await phone.get('/api/auth/me')).status).toBe(401);

    const paired = await phone.post('/api/auth/pair').send({ token });
    expect(paired.status).toBe(200);
    expect(paired.body.scope).toBe('capture');
    expect(paired.body.user.id).toBe(user.id);

    const me = await phone.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.scope).toBe('capture');
  });

  it('rejects a replayed code', async () => {
    const qr = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    const token = new URL(qr.body.url).searchParams.get('pair')!;
    await request.agent(app).post('/api/auth/pair').send({ token }).expect(200);
    const second = await request.agent(app).post('/api/auth/pair').send({ token });
    expect(second.status).toBe(401);
  });

  it('rejects a garbage or missing code without saying which', async () => {
    expect((await request(app).post('/api/auth/pair').send({ token: 'xxx' })).status).toBe(401);
    expect((await request(app).post('/api/auth/pair').send({})).status).toBe(401);
  });
});

describe('capture scope', () => {
  async function pairedPhone() {
    const qr = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    const token = new URL(qr.body.url).searchParams.get('pair')!;
    const phone = request.agent(app);
    await phone.post('/api/auth/pair').send({ token }).expect(200);
    return phone;
  }

  it('allows exactly the capture flow', () => {
    expect(isCaptureAllowed('GET', '/api/notebooks')).toBe(true);
    expect(isCaptureAllowed('POST', '/api/import')).toBe(true);
    expect(isCaptureAllowed('GET', '/api/import/jobs/abc123')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const [method, path] of [
      ['GET', '/api/notes'],
      ['GET', '/api/notes/abc123'],
      ['POST', '/api/notes'],
      ['POST', '/api/notebooks'],
      ['DELETE', '/api/notebooks/abc'],
      ['POST', '/api/auth/password'],
      ['GET', '/api/search'],
      ['GET', '/api/ai/keys'],
      ['GET', '/api/dashboard'],
      ['POST', '/api/import/batches'],
      ['GET', '/api/meta/qr'],
      // Prefix confusion must not open a door.
      ['GET', '/api/notebooksXX'],
      ['GET', '/api/import/jobs/abc/../../notes'],
    ] as const) {
      expect(isCaptureAllowed(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it('a paired phone can list notebooks', async () => {
    await insertNotebook(user.id, { name: 'Lectures' });
    const phone = await pairedPhone();
    const res = await phone.get('/api/notebooks');
    expect(res.status).toBe(200);
    expect(res.body.notebooks.map((n: { name: string }) => n.name)).toContain('Lectures');
  });

  it('a paired phone CANNOT read notes, mint another QR, or change the password', async () => {
    const phone = await pairedPhone();
    for (const res of [
      await phone.get('/api/notes'),
      await phone.get('/api/dashboard'),
      await phone.get('/api/meta/qr'),
      await phone.post('/api/notebooks').send({ name: 'x' }),
      await phone.post('/api/auth/password').send({ currentPassword: 'a', newPassword: 'bbbbbbbbbb' }),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it('does not weaken a normal session', async () => {
    const res = await user.agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    const me = await user.agent.get('/api/auth/me');
    expect(me.body.scope).toBe('full');
  });

  it('treats an unrecognised scope value as least-authority, not most', async () => {
    // Defence in depth: a corrupted or future scope string must not read as 'full'.
    const phone = await pairedPhone();
    await db.prepare("UPDATE sessions SET scope = 'something-new' WHERE user_id = ?").run(user.id);
    expect((await phone.get('/api/dashboard')).status).toBe(403);
  });

  it('a capture session expires in hours, where a sign-in lasts 30 days', async () => {
    await pairedPhone();
    const row = await db
      .prepare("SELECT expires_at FROM sessions WHERE scope = 'capture'")
      .get<{ expires_at: string }>();
    expect(row).toBeTruthy();
    const hours = (new Date(row!.expires_at).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(1);
    expect(hours).toBeLessThanOrEqual(12);
  });

  it('sets the session cookie httpOnly, so the phone\'s JS cannot read the credential', async () => {
    const qr = await user.agent.get('/api/meta/qr').set('Host', 'unote-six.vercel.app');
    const token = new URL(qr.body.url).searchParams.get('pair')!;
    const res = await request(app).post('/api/auth/pair').send({ token }).expect(200);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = setCookie.find((c) => c.startsWith(`${COOKIE_NAME}=`));
    expect(session).toBeTruthy();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
  });
});
