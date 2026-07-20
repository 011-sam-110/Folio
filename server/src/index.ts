import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, purgeExpiredDeletedNotes } from './db.js';

/**
 * Boot: apply the schema, then take the port.
 *
 * migrate() must finish before the first request, so it is awaited here rather than
 * raced with listen(). It is memoised in db.ts, so app.ts's per-request gate (which
 * exists for serverless, where there is no boot hook) becomes a no-op after this.
 *
 * The trash purge is best-effort: a failure there is worth logging but is not a reason
 * to refuse to serve, so it does not block listen().
 */
async function main(): Promise<void> {
  await migrate();

  purgeExpiredDeletedNotes(30).then(
    (purged) => {
      if (purged > 0) console.log(`[folio] purged ${purged} note(s) deleted more than 30 days ago`);
    },
    (err) => console.error('[folio] trash purge failed:', err),
  );

  buildApp().listen(config.port, config.host, () => {
    console.log(`[folio] API listening on http://localhost:${config.port} (bound ${config.host})`);
  });
}

main().catch((err) => {
  console.error('[folio] failed to start:', err);
  process.exit(1);
});
