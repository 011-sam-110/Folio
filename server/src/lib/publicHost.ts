/**
 * Reject URLs that point somewhere only the server can reach.
 *
 * This guards ONE thing: the custom endpoint a user may save alongside their own API key.
 * The server dereferences that URL, and `callOnce` puts the first 300 bytes of a non-200
 * response body into the error it returns to the caller. Together that is a readable SSRF:
 * point the endpoint at `http://169.254.169.254/...` (cloud metadata), or at any internal
 * service, and read the reply back out of the error message.
 *
 * Deliberately NOT applied to `FOLIO_AI_BASE_URL`. That value is set by whoever operates
 * the deployment, its documented default is `http://localhost:3001/v1`, and self-hosting
 * against a gateway on the same box or LAN is the intended setup. The operator reaching
 * their own network is configuration; a user steering the server into it is an attack. The
 * trust boundary is who supplied the value, not what it points at.
 */

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::]', '::', 'metadata.google.internal']);

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true; // malformed, refuse
  if (a === 127 || a === 0) return true;              // loopback, "this network"
  if (a === 10) return true;                          // private
  if (a === 192 && b === 168) return true;            // private
  if (a === 172 && b >= 16 && b <= 31) return true;   // private
  if (a === 169 && b === 254) return true;            // link-local, and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // URL keeps IPv6 literals in brackets.
  const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const lower = inner.toLowerCase();
  if (lower === '::1' || lower === '::') return true;

  /**
   * IPv4-mapped addresses re-checked under the v4 rules, otherwise `::ffff:10.0.0.1` walks
   * straight past them.
   *
   * Both spellings have to be handled, and the second one is the one that actually shows up:
   * the WHATWG URL parser NORMALISES the dotted form, so `http://[::ffff:10.0.0.1]/` arrives
   * here as `::ffff:a00:1`. Matching only the readable spelling looks correct, passes a
   * hand-written test using the literal string, and blocks nothing in production.
   */
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted) return isPrivateIpv4(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;  // unique local, fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;  // link-local, fe80::/10
  return false;
}

export interface HostCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Is this a URL a user is allowed to make the server call?
 *
 * Honest about its limits: this checks the hostname as written. A public name that RESOLVES
 * to a private address (DNS rebinding) still passes, because catching that needs resolution
 * at request time plus pinning the resolved address through the connection, which Node's
 * fetch does not expose. Closing that properly means a custom agent with a lookup hook. What
 * this does stop is the direct, trivial version, which is the one that gets used.
 */
export function checkUserSuppliedUrl(raw: string): HostCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Custom endpoint must be a valid URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Custom endpoint must be an http or https URL.' };
  }

  // Credentials in the URL would be stored in plaintext in base_url, beside a key we went to
  // the trouble of encrypting.
  if (url.username || url.password) {
    return { ok: false, reason: 'Custom endpoint must not embed a username or password.' };
  }

  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    return { ok: false, reason: 'Custom endpoint must be a public address.' };
  }

  return { ok: true };
}
