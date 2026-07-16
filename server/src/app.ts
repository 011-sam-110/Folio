import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, UPLOADS_DIR, config } from './config.js';
import './db.js';

import notebooksRouter from './routes/notebooks.js';
import notesRouter from './routes/notes.js';
import searchRouter from './routes/search.js';
import tagsRouter from './routes/tags.js';
import dashboardRouter from './routes/dashboard.js';
import aiRouter from './routes/ai.js';
import importsRouter from './routes/imports.js';
import studyRouter from './routes/study.js';
import metaRouter from './routes/meta.js';

/**
 * The app ships with no auth (LAN-only trust, per SPEC §8), but leaving CORS wide open
 * is a broader exposure than that decision covered: any website the student visits in the
 * same browser could otherwise cross-origin fetch localhost/LAN Folio and read/write notes.
 * So restrict Origin to what actually serves this app — localhost dev/served origins and
 * private-LAN hosts on the app's ports — while still allowing same-origin/no-Origin requests
 * (curl, mobile PWA served from the API itself, server-to-server).
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header (same-origin nav, curl, native app) — allow
  if (config.extraCorsOrigins.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  // Private-LAN ranges a phone/tablet on the same network would use.
  const isPrivateLan =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith('.local');
  return isLocalhost || isPrivateLan;
}

export function buildApp(): express.Express {
  const app = express();
  app.use(
    cors({
      origin(origin, cb) {
        cb(null, isAllowedOrigin(origin));
      },
    }),
  );
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/notebooks', notebooksRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/import', importsRouter);
  app.use('/api/study', studyRouter);
  app.use('/api/meta', metaRouter);

  app.use('/uploads', express.static(UPLOADS_DIR));

  // Serve the built SPA when web/dist exists (single-port mode, used for phone-on-LAN).
  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // JSON 404 for unknown API routes.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler: always JSON, never HTML stack pages.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status ?? 500;
    if (status >= 500) console.error('[folio]', err);
    res.status(status).json({ error: message });
  });

  return app;
}
