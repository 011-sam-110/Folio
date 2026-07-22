// CORS origin policy.
//
// Worth testing rather than eyeballing because the branch that matters is the one a local
// run never takes: IS_SERVERLESS is read from process.env.VERCEL at module load, so the
// deployed behaviour is invisible on a developer machine. Without this, "LAN origins are
// refused in production" is an assertion nobody can check until it is wrong.
//
// Each case re-imports the module graph under a stubbed environment, since both
// IS_SERVERLESS and config.deployedOrigins are captured at import time.

import { describe, it, expect, afterEach, vi } from 'vitest';

async function loadIsAllowedOrigin(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  const mod = await import('../src/app.js');
  return mod.isAllowedOrigin;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('isAllowedOrigin on a local or self-hosted run', () => {
  it('allows localhost and private-LAN origins, which is what self-hosting needs', async () => {
    const allowed = await loadIsAllowedOrigin({ VERCEL: undefined, FOLIO_CORS_ORIGINS: '' });
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:4780',
      'http://192.168.1.40:4780',
      'http://10.0.0.5:4780',
      'http://172.16.3.9:4780',
      'http://macbook.local:4780',
    ]) {
      expect(allowed(origin), origin).toBe(true);
    }
  });

  it('still refuses a public origin', async () => {
    const allowed = await loadIsAllowedOrigin({ VERCEL: undefined, FOLIO_CORS_ORIGINS: '' });
    expect(allowed('https://evil.example')).toBe(false);
    // 172.32 is outside the private 172.16-31 block and must not be mistaken for it.
    expect(allowed('http://172.32.0.1')).toBe(false);
  });
});

describe('isAllowedOrigin on the deployed serverless app', () => {
  const SERVERLESS = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'unote.vercel.app' };

  it('refuses localhost, private-LAN and .local origins', async () => {
    // The actual finding. Paired with credentials: true, allowing these means a page on the
    // victim's own machine or LAN can make credentialed cross-origin requests against
    // production and read their notes.
    const allowed = await loadIsAllowedOrigin({ ...SERVERLESS, FOLIO_CORS_ORIGINS: '' });
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://192.168.1.40',
      'http://10.0.0.5',
      'http://172.20.1.1',
      'http://printer.local',
    ]) {
      expect(allowed(origin), origin).toBe(false);
    }
  });

  it('allows the deployment its own hostnames', async () => {
    const allowed = await loadIsAllowedOrigin({ ...SERVERLESS, FOLIO_CORS_ORIGINS: '' });
    expect(allowed('https://unote.vercel.app')).toBe(true);
  });

  it('allows exactly what FOLIO_CORS_ORIGINS lists, which is the only escape hatch', async () => {
    // A custom domain cannot be discovered from the Vercel environment, so it has to be
    // configured here or it is refused.
    const allowed = await loadIsAllowedOrigin({
      ...SERVERLESS,
      FOLIO_CORS_ORIGINS: 'https://notes.example.edu',
    });
    expect(allowed('https://notes.example.edu')).toBe(true);
    expect(allowed('https://other.example.edu')).toBe(false);
  });

  it('allows a request with no Origin header, so curl and the PWA still work', async () => {
    const allowed = await loadIsAllowedOrigin({ ...SERVERLESS, FOLIO_CORS_ORIGINS: '' });
    expect(allowed(undefined)).toBe(true);
  });
});
