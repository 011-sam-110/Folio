import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../server/src/app.js';
import { migrate } from '../server/src/db.js';

// A serverless instance is reused across invocations, so build the Express app
// once per cold start rather than per request.
const app = buildApp();

// Schema application is idempotent and de-duplicated inside migrate(), but the
// promise is also cached here so warm invocations skip the await entirely.
let ready: Promise<void> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= migrate().catch((err) => {
    // Don't cache a failed migration - a transient Neon connection error on a cold
    // start would otherwise poison every later request on this instance.
    ready = null;
    throw err;
  });

  try {
    await ready;
  } catch (err) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Database unavailable' }));
    console.error('[folio] migration failed', err);
    return;
  }

  return app(req as never, res as never);
}
