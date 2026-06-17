import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { metaRouter } from './routes/meta';
import { batchesRouter } from './routes/batches';
import { openapiSpec } from './openapi';

/** Builds and configures the Express application. */
export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // API documentation.
  app.get('/api/openapi.json', (_req, res) => res.json(openapiSpec));
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
      customSiteTitle: 'CONI SVC DNS Checker API',
    }),
  );

  // API routes.
  app.use('/api', metaRouter);
  app.use('/api/batches', batchesRouter);

  // 404 for unknown API routes.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'notFound' });
  });

  // Centralized error handler (e.g. Multer file-size errors).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err as { code?: string; message?: string };
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'fileTooLarge',
        details: { maxUploadBytes: config.maxUploadBytes },
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'internalError' });
  });

  return app;
}
