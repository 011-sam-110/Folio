import { buildApp } from './app.js';
import { config } from './config.js';

buildApp().listen(config.port, config.host, () => {
  console.log(`[folio] API listening on http://localhost:${config.port} (bound ${config.host})`);
});
