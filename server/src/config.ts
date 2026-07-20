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

export const config = {
  port: Number(process.env.FOLIO_PORT ?? 4780),
  host: process.env.FOLIO_HOST ?? '0.0.0.0',
  // Extra allowed CORS origins (comma-separated), on top of the built-in localhost +
  // private-LAN allowance in app.ts. Empty by default.
  extraCorsOrigins: (process.env.FOLIO_CORS_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),
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
  },
};

// Serverless filesystems are read-only outside /tmp, and attachments live in
// Postgres there rather than on disk — so only prepare local directories.
if (!IS_SERVERLESS) {
  for (const dir of [DATA_DIR, UPLOADS_DIR]) fs.mkdirSync(dir, { recursive: true });
}
