import { buildApp } from './app.js';
import { config } from './config.js';
import { purgeExpiredDeletedNotes } from './db.js';

const purged = purgeExpiredDeletedNotes(30);
if (purged > 0) console.log(`[folio] purged ${purged} note(s) deleted more than 30 days ago`);

buildApp().listen(config.port, config.host, () => {
  console.log(`[folio] API listening on http://localhost:${config.port} (bound ${config.host})`);
});
