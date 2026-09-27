import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { auditWriteStats } from '../services/auditService.js';
import { metrics } from '../services/metricsService.js';

const router = Router();
const frontendMetricSchema = z.object({
  kind: z.enum(['api_request', 'page_load', 'navigation', 'web_vital', 'js_error', 'resource_error', 'long_task', 'resource_summary']).default('api_request'),
  path: z.string().trim().min(1).max(300).optional(),
  status: z.number().int().min(0).max(999).optional(),
  durationMs: z.number().finite().min(0).max(120000).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  value: z.number().finite().min(0).max(120000).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

router.use((req, res, next) => {
  if (env.NODE_ENV !== 'production') {
    next();
    return;
  }

  const suppliedToken = req.get('x-observability-token')
    ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
  if (env.OBSERVABILITY_TOKEN && suppliedToken === env.OBSERVABILITY_TOKEN) {
    next();
    return;
  }

  res.status(404).json({ error: 'not_found' });
});

async function databaseSnapshot() {
  const audit = auditWriteStats();
  try {
    await db.healthcheck();
    return { status: 'ready', pool: db.poolStats(), audit };
  } catch {
    return { status: 'unavailable', pool: db.poolStats(), audit };
  }
}

router.get('/snapshot', async (_req, res) => {
  res.json(metrics.snapshot(await databaseSnapshot()));
});

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const unsubscribe = metrics.subscribe(res, async () => metrics.snapshot(await databaseSnapshot()));
  req.on('close', unsubscribe);
});

router.post('/frontend', (req, res) => {
  const parsed = frontendMetricSchema.safeParse(req.body);
  if (parsed.success) {
    metrics.recordFrontendEvent(parsed.data);
  }
  res.status(204).end();
});

export default router;
