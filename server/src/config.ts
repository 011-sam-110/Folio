import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..'); // repo root
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = process.env.FOLIO_DB_PATH ?? path.join(DATA_DIR, 'folio.db');

// Tiny zero-dep .env loader (repo-root .env). Does not override real env vars.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = {
  port: Number(process.env.FOLIO_PORT ?? 4780),
  host: process.env.FOLIO_HOST ?? '0.0.0.0',
  ai: {
    baseUrl: (process.env.FOLIO_AI_BASE_URL ?? 'http://localhost:3001/v1').replace(/\/$/, ''),
    apiKey: process.env.FOLIO_AI_KEY ?? '',
    // 'auto' on the gateway can route to dead providers — always pin, with fallbacks.
    textModels: (process.env.FOLIO_AI_TEXT_MODELS ?? 'gemini-2.5-flash,llama-3.3-70b-versatile,mistral-medium-latest')
      .split(',').map(s => s.trim()).filter(Boolean),
    visionModels: (process.env.FOLIO_AI_VISION_MODELS ?? 'gemini-2.5-flash')
      .split(',').map(s => s.trim()).filter(Boolean),
    timeoutMs: Number(process.env.FOLIO_AI_TIMEOUT_MS ?? 90_000),
  },
};

for (const dir of [DATA_DIR, UPLOADS_DIR]) fs.mkdirSync(dir, { recursive: true });
