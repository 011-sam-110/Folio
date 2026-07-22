import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..'); // repo root
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

/** True when running as a Vercel serverless function (read-only FS except /tmp). */
export const IS_SERVERLESS = Boolean(process.env.VERCEL);

// Tiny zero-dep .env loader (repo-root .env). Does not override real env vars.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * Postgres connection string. Neon in production (injected by the Vercel
 * integration), local Docker Postgres for development and tests.
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  'postgresql://folio:folio@localhost:5433/folio';

/**
 * Key used to sign session cookies. A generated fallback keeps local dev
 * frictionless, but it changes per boot (logging everyone out on restart) and
 * would differ across serverless instances — so production must set it.
 */
export const SESSION_SECRET = (() => {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return 'dev-only-insecure-session-secret';
})();

/**
 * Read a positive integer setting, falling back to the default when the value is missing
 * or not a usable number.
 *
 * `Number('')`, `Number('100 ')` and `Number('one hundred')` do not fail loudly, they
 * produce `NaN`. That matters for the AI quotas specifically, because every comparison
 * against `NaN` is false: `remaining <= 0` never fires, and a single typo in a Vercel
 * environment variable would silently remove the ceiling rather than break anything
 * visible. A limit that fails open is worse than no limit, because nobody looks at it.
 */
export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
    if (raw !== undefined && raw.trim() !== '') {
      console.warn(`[config] ignoring unusable numeric env value ${JSON.stringify(raw)}, using ${fallback}`);
    }
    return fallback;
  }
  return Math.floor(parsed);
}

export const config = {
  port: Number(process.env.FOLIO_PORT ?? 4780),
  host: process.env.FOLIO_HOST ?? '0.0.0.0',
  // Extra allowed CORS origins (comma-separated), on top of the built-in localhost +
  // private-LAN allowance in app.ts. Empty by default.
  //
  // On serverless this is the ONLY way to add an origin, because the LAN allowance is off
  // there (see isAllowedOrigin). A custom domain needs listing here: Vercel does not expose
  // one through the environment, so deployedOrigins below cannot discover it.
  extraCorsOrigins: (process.env.FOLIO_CORS_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),

  /**
   * Origins this deployment is actually served from, read from Vercel's own environment.
   *
   * VERCEL_PROJECT_PRODUCTION_URL is the stable production hostname; VERCEL_URL and
   * VERCEL_BRANCH_URL are the per-deployment and per-branch preview hostnames, which is what
   * a preview build is browsed at. All are bare hostnames, so the scheme is added here.
   *
   * Same-origin requests are not CORS-checked by the browser at all, so this is not what
   * keeps the site working; it is here so that the deployment's own preview and production
   * hostnames still resolve as allowed when they differ from the one being browsed.
   */
  deployedOrigins: [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
  ].filter(Boolean).map((h) => `https://${h}`),
  ai: {
    baseUrl: (process.env.FOLIO_AI_BASE_URL ?? 'http://localhost:3001/v1').replace(/\/$/, ''),
    apiKey: process.env.FOLIO_AI_KEY ?? '',
    // 'auto' on the gateway can route to dead providers — always pin, with fallbacks.
    textModels: (process.env.FOLIO_AI_TEXT_MODELS ?? 'gemini-2.5-flash,llama-3.3-70b-versatile,mistral-medium-latest')
      .split(',').map(s => s.trim()).filter(Boolean),
    // Vision needs its own fallback chain too — a single provider hiccup on the only
    // vision model used to fail every photo import.
    visionModels: (process.env.FOLIO_AI_VISION_MODELS ?? 'gemini-2.5-flash,gemini-3.5-flash,gemini-2.5-flash-lite')
      .split(',').map(s => s.trim()).filter(Boolean),
    timeoutMs: Number(process.env.FOLIO_AI_TIMEOUT_MS ?? 90_000),

    /**
     * Monthly ceiling on shared-pool AI calls, per account and per IP.
     *
     * The shared pool is one set of free-tier provider keys funded by the operator, so
     * every user spends from the same budget. Without a cap, one enthusiastic user (or
     * one script) exhausts the month for everyone else on day two.
     *
     * Two dimensions, because either alone is trivially defeated: an account cap alone
     * falls to signing up ten times, and an IP cap alone falls to a phone hotspot. A
     * request must clear BOTH.
     *
     * The IP ceiling is deliberately much higher than the account one. This is a student
     * app, and a university or halls-of-residence NAT can put hundreds of legitimate
     * users behind a single address — sized at 10x the per-account allowance so a shared
     * egress does not lock out a whole campus. Users who need more than either limit can
     * add their own provider key, which bypasses the pool entirely.
     */
    freeMonthlyPerUser: positiveIntEnv(process.env.FOLIO_AI_FREE_MONTHLY_USER, 100),
    freeMonthlyPerIp: positiveIntEnv(process.env.FOLIO_AI_FREE_MONTHLY_IP, 1000),

    /**
     * Key-encryption key for user-supplied provider keys (AES-256-GCM at rest).
     *
     * Falls back to a value derived from SESSION_SECRET so local development needs no
     * extra setup. The consequence is real and worth stating: rotating SESSION_SECRET
     * without setting this makes every stored key undecryptable, and users must re-enter
     * them. Production should set FOLIO_AI_KEK explicitly and rotate it independently.
     */
    kek: process.env.FOLIO_AI_KEK ?? `derived:${SESSION_SECRET}`,
  },

  /**
   * Social sign-in (OAuth). Credentials come from the environment ONLY and are never
   * committed. A provider is treated as enabled only when BOTH its id and secret are
   * present (see auth/oauthProviders.ts), which is what drives the feature-flag gate:
   * with these unset — the default, and production until they are configured — no social
   * buttons are shown and the routes refuse the provider.
   *
   * `baseUrl` is the public origin used to build the redirect_uri that must match what is
   * registered with each provider. Leave it empty in production (the Vercel production
   * hostname is used automatically); set OAUTH_BASE_URL for local dev and custom domains.
   */
  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    },
    baseUrl: process.env.OAUTH_BASE_URL ?? '',
  },
};

// Serverless filesystems are read-only outside /tmp, and attachments live in
// Postgres there rather than on disk — so only prepare local directories.
if (!IS_SERVERLESS) {
  for (const dir of [DATA_DIR, UPLOADS_DIR]) fs.mkdirSync(dir, { recursive: true });
}
