import { createApp } from './app';
import { config } from './config';
import { markStaleBatchesInterrupted } from './db/database';

/** Service bootstrap. */
function main(): void {
  // A previous process may have died mid-batch; flag those as interrupted.
  const interrupted = markStaleBatchesInterrupted();
  if (interrupted > 0) {
    // eslint-disable-next-line no-console
    console.log(`Marked ${interrupted} stale batch(es) as interrupted.`);
  }

  const app = createApp();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `CONI SVC DNS Checker API listening on port ${config.port} ` +
        `(docs: /api/docs)`,
    );
  });
}

main();
