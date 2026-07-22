/**
 * Where is this deployment reachable from a DIFFERENT device?
 *
 * This exists because /api/meta/qr previously answered that question with
 * `os.networkInterfaces()` - the addresses of the machine running the process. That is
 * the right answer for exactly one deployment shape (a laptop serving the built SPA to a
 * phone on the same Wi-Fi) and is wrong everywhere else. On Vercel it returns the
 * function container's own private VPC address, so the QR encoded something like
 * `http://10.x.x.x:4780`, which no phone on earth can open.
 *
 * The reliable signal is the request itself: the browser asking for a QR is *already*
 * talking to this deployment at an address that demonstrably resolves and routes. Copy
 * that. Only when the browser reached us over loopback (a local dev machine, where the
 * request host really is unreachable from a phone) is there anything to infer, and that
 * is the one case where a LAN address is the correct answer.
 *
 * Host headers are attacker-influenced, and the value here ends up in a QR carrying a
 * pairing token - so on a hosted deployment the derived origin is checked against the
 * hostnames this deployment actually answers to before it is trusted. See appPublicUrl.
 */

import os from 'node:os';
import type { Request } from 'express';
import { IS_SERVERLESS, config } from '../config.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

/**
 * Interface names that belong to a virtual adapter rather than a network a phone is on.
 * Name matching catches the ones that announce themselves (WSL, VirtualBox, VMware,
 * Docker, Tailscale); address matching below catches the ones that do not.
 */
const VIRTUAL_IFACE = /vethernet|virtualbox|vmware|hyper-?v|wsl|docker|bridge|tailscale|zerotier|utun|tun\d|tap\d|npcap|loopback/i;

export interface RequestOrigin {
  proto: string;
  /** Hostname as written in the Host header - IPv6 literals keep their brackets. */
  hostname: string;
  /** Port as written, or '' when the Host header carried none (default 80/443). */
  port: string;
  /** `proto://hostname[:port]` */
  origin: string;
}

/** A hostname safe to interpolate into a URL. Anything else is treated as absent. */
function isSafeHostname(host: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(host) || /^\[[0-9A-Fa-f:.]+\]$/.test(host);
}

/** Split a Host header authority into hostname + port, handling `[::1]:5199`. */
export function splitAuthority(raw: string): { hostname: string; port: string } | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    const hostname = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest && !rest.startsWith(':')) return null;
    const port = rest.slice(1);
    if (port && !/^\d{1,5}$/.test(port)) return null;
    return isSafeHostname(hostname) ? { hostname, port } : null;
  }

  const colon = value.lastIndexOf(':');
  if (colon === -1) return isSafeHostname(value) ? { hostname: value, port: '' } : null;
  const port = value.slice(colon + 1);
  // A colon with a non-numeric tail is not a port - and a bare IPv6 literal is not a
  // legal Host header authority, so there is nothing valid left to salvage.
  if (!/^\d{1,5}$/.test(port)) return null;
  const hostname = value.slice(0, colon);
  return isSafeHostname(hostname) ? { hostname, port } : null;
}

/**
 * The origin the client used to reach us.
 *
 * `X-Forwarded-Host` is preferred over `Host` because a proxy rewrites the latter; the
 * app sets `trust proxy: 1` (see app.ts), which is also what makes `req.protocol` report
 * `https` on Vercel rather than the plaintext hop behind the CDN. A comma-separated
 * forwarded chain is taken from its FIRST entry, which is the client-facing hop.
 */
export function requestOrigin(req: Request): RequestOrigin | null {
  const forwarded = req.get('x-forwarded-host');
  const raw = (forwarded ? forwarded.split(',')[0] : req.get('host')) ?? '';
  const parts = splitAuthority(raw);
  if (!parts) return null;
  // A hosted deployment is HTTPS, full stop - the same assumption the session cookie's
  // `secure` flag already makes. Deriving the scheme from `req.protocol` there would put an
  // `http://` URL in the QR the moment X-Forwarded-Proto went missing, and a phone opening
  // it would send the pairing code in cleartext before the redirect to HTTPS.
  const proto = IS_SERVERLESS || req.protocol === 'https' ? 'https' : 'http';
  return {
    proto,
    hostname: parts.hostname,
    port: parts.port,
    origin: `${proto}://${parts.hostname}${parts.port ? `:${parts.port}` : ''}`,
  };
}

/** Did this request arrive over loopback - i.e. is the host it used private to this box? */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * This machine's IPv4 addresses, best guess first.
 *
 * Ranking, not filtering: a laptop can have three or four plausible-looking addresses and
 * only one of them is the Wi-Fi the phone is on. Guessing right every time is not
 * possible, so the whole ranked list is returned and the UI offers the alternatives (see
 * PhoneCaptureModal). The previous implementation took `[0]` from an unordered enumeration,
 * which on this developer's machine was the WSL virtual adapter.
 */
export function lanAddresses(): string[] {
  const scored: Array<{ address: string; score: number }> = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      scored.push({ address: info.address, score: rankAddress(name, info.address) });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.address.localeCompare(b.address));
  return scored.map((s) => s.address);
}

/** Lower is more likely to be the network a phone can reach. */
function rankAddress(iface: string, address: string): number {
  if (VIRTUAL_IFACE.test(iface)) return 100;
  // Default host-only / NAT ranges of the hypervisors that do NOT name their adapter
  // recognisably (VirtualBox ships 192.168.56.x on an interface called "Ethernet 3").
  if (/^192\.168\.(56|91|136|137)\./.test(address)) return 90;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 50; // Docker/WSL favour this block
  if (/^169\.254\./.test(address)) return 95;                 // link-local, no DHCP
  if (/^192\.168\./.test(address)) return 10;                 // ordinary home/office Wi-Fi
  if (/^10\./.test(address)) return 20;
  return 30;
}

/**
 * The absolute base URL to put in front of a path handed to another device.
 *
 * Precedence:
 *   1. FOLIO_PUBLIC_URL - explicit, and the only thing that can be right behind a custom
 *      domain, a tunnel (ngrok/Cloudflare) or a reverse proxy that rewrites Host.
 *   2. The request's own origin, when it is trustworthy:
 *        - hosted: only if it matches a hostname this deployment answers to, otherwise a
 *          forged Host/X-Forwarded-Host would put an attacker's domain in a QR that
 *          carries a live pairing token. Falls back to the configured production origin.
 *        - local: trusted as-is, unless it is loopback (a phone cannot open localhost),
 *          in which case the hostname is swapped for the best LAN address.
 *   3. A LAN address with the configured port, for a request with no usable Host at all.
 *
 * `browserPort` exists for one specific local case. Under `npm run dev` the SPA is served
 * by Vite (5199) which proxies /api to Express (4780) - and Vite's proxy REWRITES the Host
 * header to its target, so the request arrives claiming port 4780. Substituting a LAN
 * address for the loopback host therefore produces a URL on the API port, which only serves
 * the SPA if web/dist happens to have been built. The browser is the only party that knows
 * which port is actually serving the page, so it may say - but it may only supply a PORT,
 * never a host. A 16-bit integer cannot redirect the QR at another machine, which is what
 * makes accepting it from the client safe. Ignored entirely on a hosted deployment.
 *
 * Returns '' when nothing can be determined; callers must treat that as "cannot offer
 * this feature" rather than emitting a relative or half-formed URL.
 */
export function appPublicUrl(req: Request, browserPort?: string): string {
  const override = (process.env.FOLIO_PUBLIC_URL ?? '').trim();
  if (override) return override.replace(/\/+$/, '');

  const found = requestOrigin(req);

  if (IS_SERVERLESS) {
    const known = [...config.deployedOrigins, ...config.extraCorsOrigins];
    if (found && known.includes(found.origin)) return found.origin;
    if (known.length > 0) return known[0];
    // No VERCEL_* hostname and no configured origin: there is nothing to validate
    // against, so the request origin is the only information available. Documented
    // rather than silent - a deployment in this state should set FOLIO_PUBLIC_URL.
    if (found) {
      console.warn('[publicUrl] no known deployment origin configured; trusting request Host');
      return found.origin;
    }
    return '';
  }

  if (found && !isLoopbackHostname(found.hostname)) return found.origin;

  const lan = lanAddresses()[0];
  if (!lan) return found?.origin ?? '';
  const port = normalisePort(browserPort) || found?.port || String(config.port);
  return `${found?.proto ?? 'http'}://${lan}${port ? `:${port}` : ''}`;
}

/** A caller-supplied port, or '' if it is not one. Digits only, and in range. */
export function normalisePort(raw: string | undefined): string {
  if (!raw || !/^\d{1,5}$/.test(raw)) return '';
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? String(n) : '';
}
