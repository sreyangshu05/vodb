import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import publicRouter from './routes/public.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { db } from './lib/db.js';
import mediaRouter from './routes/media.js';
import { logger } from './utils/logger.js';
import { auditWriteStats, waitForAuditWrites } from './services/auditService.js';
import observabilityRouter from './routes/observability.js';
import { metrics } from './services/metricsService.js';

const app = express();
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
app.set('trust proxy', 1);
app.use(requestIdMiddleware);

// Keep local Vite fallback/preview and admin preview origins available even
// when an older .env file is still being used by a running development process.
// Keep the exact public site origins allowed even if a hosted environment
// omits NODE_ENV or has a stale CORS_ORIGIN value.
const allowedCorsOrigins = new Set([
  ...env.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean),
  'https://voiceofdigibengal.com',
  'https://www.voiceofdigibengal.com',
  ...(env.NODE_ENV !== 'production'
    ? [
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
        'http://localhost:4174',
        'http://127.0.0.1:4174',
      ]
    : []),
]);
const frontendUrl = env.FRONTEND_URL.trim();
if (frontendUrl && !frontendUrl.includes('localhost') && !frontendUrl.includes('127.0.0.1')) {
  allowedCorsOrigins.add(frontendUrl.replace(/\/$/, ''));
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedCorsOrigins.has(origin) || (origin === 'null' && env.NODE_ENV !== 'production')) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed by CORS policy: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Media-Access-Token', 'X-Request-Id', 'X-Observability-Token'],
  })
);
app.use(helmet({
  crossOriginResourcePolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", ...allowedCorsOrigins],
    },
  },
}));
app.use(express.json({ limit: '7mb' }));
app.use(morgan('dev'));

app.get('/', (_req, res) => {
  res.json({ service: 'voice-of-digi-bengal-backend', status: 'ok' });
});

app.get('/api/v1/health', (_req, res) => {
  res.json({ ok: true, service: 'voice-of-digi-bengal-backend', timestamp: new Date().toISOString() });
});

app.get('/api/v1/readiness', async (_req, res) => {
  try {
    await db.healthcheck();
    res.json({
      ok: true,
      service: 'voice-of-digi-bengal-backend',
      database: 'ready',
      pool: db.poolStats(),
      audit: auditWriteStats(),
    });
  } catch {
    res.status(503).json({
      ok: false,
      service: 'voice-of-digi-bengal-backend',
      database: 'unavailable',
    });
  }
});

// Image elements can request many media URLs during one page render. Mount
// binary media before the general JSON API limiter so an image-heavy page
// cannot exhaust the public content request budget.
app.use('/api/v1/media', mediaRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1', publicRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/observability', observabilityRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const port = env.PORT;
if (process.env.NODE_ENV !== 'test' && isMain) {
  const server = app.listen(port, '0.0.0.0', () => {
    metrics.markRunning();
    logger.info('backend_started', { port, environment: env.NODE_ENV });
  });

  let shutdownPromise: Promise<void> | undefined;

  // Stop accepting new HTTP work before draining audit writes and closing PostgreSQL.
  const shutdown = (signal: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      metrics.markStopping();
      metrics.closeStreams();
      logger.info('backend_shutdown_requested', { signal });
      await new Promise<void>((resolve) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            logger.error('backend_http_shutdown_failed', { message: error.message });
          }
          resolve();
        });
      });
      await waitForAuditWrites();
      await db.end();
      logger.info('backend_shutdown_complete', { signal });
      process.exit(0);
    })();

    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

export default app;
