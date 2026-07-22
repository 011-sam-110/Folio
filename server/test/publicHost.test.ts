import { describe, expect, it } from 'vitest';
import { checkUserSuppliedUrl } from '../src/lib/publicHost.js';
import { positiveIntEnv } from '../src/config.js';

/**
 * Both of these guard properties that fail SILENTLY when broken, which is why they are
 * tested directly rather than through a route. A quota that stops counting and an endpoint
 * check that stops blocking both look exactly like a working system from the outside.
 */

describe('checkUserSuppliedUrl', () => {
  it('allows an ordinary public https endpoint', () => {
    expect(checkUserSuppliedUrl('https://api.openai.com/v1').ok).toBe(true);
    expect(checkUserSuppliedUrl('https://gateway.example.co.uk:8443/v1').ok).toBe(true);
  });

  it('rejects non-http schemes', () => {
    // The server dereferences this value, so file: and friends are a read primitive.
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com']) {
      expect(checkUserSuppliedUrl(url).ok, url).toBe(false);
    }
  });

  it('rejects loopback and private ranges', () => {
    // The readable SSRF: the server reaches these, the user does not, and callOnce puts part
    // of a non-200 body into the error the caller receives.
    for (const host of [
      'http://localhost:3001/v1',
      'http://127.0.0.1/v1',
      'http://127.9.9.9/v1',
      'http://10.0.0.5/v1',
      'http://192.168.1.10/v1',
      'http://172.16.0.1/v1',
      'http://172.31.255.255/v1',
      'http://0.0.0.0/v1',
      'http://100.64.0.1/v1',
    ]) {
      expect(checkUserSuppliedUrl(host).ok, host).toBe(false);
    }
  });

  it('rejects cloud metadata addresses specifically', () => {
    // 169.254.169.254 is the single highest-value SSRF target on any cloud host.
    expect(checkUserSuppliedUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(checkUserSuppliedUrl('http://metadata.google.internal/computeMetadata/v1/').ok).toBe(false);
  });

  it('rejects private IPv6, including IPv4-mapped forms', () => {
    // Without the mapped case, ::ffff:10.0.0.1 walks straight past the IPv4 rules.
    for (const host of ['http://[::1]/v1', 'http://[fc00::1]/v1', 'http://[fe80::1]/v1', 'http://[::ffff:10.0.0.1]/v1']) {
      expect(checkUserSuppliedUrl(host).ok, host).toBe(false);
    }
  });

  it('rejects internal-only hostname suffixes', () => {
    for (const host of ['http://printer.local/v1', 'http://db.internal/v1', 'http://foo.localhost/v1']) {
      expect(checkUserSuppliedUrl(host).ok, host).toBe(false);
    }
  });

  it('rejects credentials embedded in the URL', () => {
    // base_url is stored in plaintext, next to a key we bothered to encrypt.
    expect(checkUserSuppliedUrl('https://user:secret@api.example.com/v1').ok).toBe(false);
  });

  it('rejects an unparseable URL rather than throwing', () => {
    expect(checkUserSuppliedUrl('not a url').ok).toBe(false);
    expect(checkUserSuppliedUrl('').ok).toBe(false);
  });
});

describe('positiveIntEnv', () => {
  it('reads a valid value', () => {
    expect(positiveIntEnv('250', 100)).toBe(250);
    expect(positiveIntEnv('0', 100)).toBe(0);
  });

  it('falls back to the default rather than yielding NaN', () => {
    /**
     * The property that matters. Every comparison against NaN is false, so a quota limit of
     * NaN means `remaining <= 0` never fires and the ceiling silently disappears. A single
     * typo in a Vercel environment variable would have removed the limit while the app kept
     * reporting a healthy-looking usage figure.
     */
    for (const bad of ['one hundred', 'abc', '', '   ', undefined, '12abc']) {
      expect(positiveIntEnv(bad, 100), String(bad)).toBe(100);
    }
  });

  it('falls back on a negative value', () => {
    expect(positiveIntEnv('-5', 100)).toBe(100);
  });

  it('floors a fractional value', () => {
    expect(positiveIntEnv('10.9', 100)).toBe(10);
  });
});
