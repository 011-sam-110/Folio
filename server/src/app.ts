import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, UPLOADS_DIR, config } from './config.js';
import { migrate } from './db.js';
import { requireAuth } from './auth/middleware.js';

import authRouter from './routes/auth.js';
import notebooksRouter from './routes/notebooks.js';
import notesRouter from './routes/notes.js';
import searchRouter from './routes/search.js';
import tagsRouter from './routes/tags.js';
import dashboardRouter from './routes/dashboard.js';
import aiRouter from './routes/ai.js';
import importsRouter from './routes/imports.js';
import studyRouter from './routes/study.js';
import templatesRouter from './routes/templates.js';
import canvasRouter from './routes/canvas.js';
import shareRouter from './routes/share.js';
import metaRouter from './routes/meta.js';

/**
 * The app is multi-user and cookie-authenticated, which makes a permissive CORS policy
 * strictly worse than it was under the old LAN-only trust model: the session cookie would
 * ride along on any cross-origin request, so any website the student visits in the same
 * browser could read and write their notes. Restrict Origin to what actually serves this
 * app — localhost dev/served origins and private-LAN hosts — while still allowing
 * same-origin/no-Origin requests (curl, mobile PWA served from the API itself).
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
      // Session auth is cookie-based, so the browser only attaches the cookie to
      // cross-origin requests when the response allows credentials.
      credentials: true,
    }),
  );
  // 20mb: a photo import posts the image inline. Lowering this breaks photo capture.
  app.use(express.json({ limit: '20mb' }));

  // Liveness only — no DB, no session, so it stays useful when either is broken.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Apply the schema before any route touches the database. `migrate()` memoises its own
  // promise, so this is a single settled-promise await per request after the first — but
  // it has to be a request-time gate, not just a boot step: on Vercel there is no boot
  // hook, and a cold instance's first request would otherwise hit missing tables.
  app.use('/api', (_req, _res, next) => {
    migrate().then(() => next(), next);
  });

  // Unauthenticated by necessity: signup/login/logout/me are how a session is obtained
  // in the first place. This router guards its own one privileged route (/password).
  app.use('/api/auth', authRouter);

  // Public share links: guests have no account, so this router cannot sit behind
  // requireAuth. It guards each route individually instead — the owner-only routes
  // (/notes/:id/shares, /shares/:id) with requireAuth, and the guest routes with
  // requireShareAccess, which validates the share token and password gate.
  // Mounted before the routers below so /api/notes/:noteId/shares resolves here.
  app.use('/api', shareRouter);

  // Everything below is user-owned data. requireAuth is applied here, once, rather than
  // inside each router: one place to audit, and one session lookup per request.
  // `userId(req)` inside these routers throws if the guard is ever removed, so a
  // mis-mount fails loudly with a 500 rather than silently querying `undefined`.
  app.use('/api/notebooks', requireAuth, notebooksRouter);
  app.use('/api/notes', requireAuth, notesRouter);
  app.use('/api/search', requireAuth, searchRouter);
  app.use('/api/tags', requireAuth, tagsRouter);
  app.use('/api/dashboard', requireAuth, dashboardRouter);
  app.use('/api/ai', requireAuth, aiRouter);
  app.use('/api/import', requireAuth, importsRouter);
  app.use('/api/study', requireAuth, studyRouter);
  app.use('/api/templates', requireAuth, templatesRouter);
  app.use('/api/canvas', requireAuth, canvasRouter);
  // /api/meta reports LAN addresses and AI configuration. That is deployment detail
  // about the host, not public information, so it is signed-in-only like the rest.
  app.use('/api/meta', requireAuth, metaRouter);

  app.use('/uploads', express.static(UPLOADS_DIR));

  // JSON 404 for unknown API routes. Must precede the SPA catch-all, or an unknown
  // /api path would be answered with index.html.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Serve the built SPA when web/dist exists (single-port mode, used for phone-on-LAN).
  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    // Express 5 removed the bare '*' path pattern — a named wildcard ('/*splat') is
    // now required, and '*' throws a path-to-regexp parse error at mount time.
    app.get('/*splat', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // Central error handler: always JSON, never HTML stack pages.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status ?? 500;
    if (status >= 500) console.error('[folio]', err);
    res.status(status).json({ error: message });
  });

  return app;
}
