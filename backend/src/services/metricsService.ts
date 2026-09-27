import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Request, Response } from 'express';

type DurationMetric = {
  count: number;
  totalDurationMs: number;
  samples: number[];
  lastDurationMs: number | null;
  lastCompletedAt: string | null;
};

type EndpointMetric = DurationMetric & {
  active: number;
  failures: number;
  serverErrors: number;
  clientErrors: number;
  statusCodes: Record<string, number>;
  lastStatus: number | null;
};

type FrontendMetric = DurationMetric & {
  failures: number;
  pageViews: number;
  pageLoads: number;
  pageLoadDurationMs: number;
  pageLoadTtfbMs: number;
  pageLoadDomContentLoadedMs: number;
  pageLoadTransferBytes: number;
  pageLoadEncodedBytes: number;
  pageLoadDecodedBytes: number;
  pageLoadRedirects: number;
  javascriptErrors: number;
  resourceErrors: number;
  longTasks: number;
  longTaskDurationMs: number;
  resourceCount: number;
  resourceTransferBytes: number;
  resourceCachedCount: number;
  webVitals: Record<string, DurationMetric>;
  lastPath: string | null;
  lastStatus: number | null;
};

type DatabaseMetric = DurationMetric & {
  active: number;
  failures: number;
  operations: Record<string, number>;
  lastErrorAt: string | null;
};

export type FrontendMetricEvent = {
  kind: 'api_request' | 'page_load' | 'navigation' | 'web_vital' | 'js_error' | 'resource_error' | 'long_task' | 'resource_summary';
  path?: string;
  status?: number;
  durationMs?: number;
  name?: string;
  value?: number;
  metadata?: Record<string, number | string | boolean | null>;
};

const MAX_SAMPLES = 256;
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const startedAt = new Date().toISOString();
const endpoints = new Map<string, EndpointMetric>();
const rateCounters = new Map<string, { buckets: number[]; seconds: Array<number | null>; startedAt: number | null }>();
const databaseOperationDurations = new Map<string, DurationMetric>();
const databaseOperationFailures = new Map<string, number>();
const databaseOperationTimers = new Map<bigint, string>();
const frontend: FrontendMetric = {
  count: 0,
  totalDurationMs: 0,
  samples: [],
  lastDurationMs: null,
  lastCompletedAt: null,
  failures: 0,
  pageViews: 0,
  pageLoads: 0,
  pageLoadDurationMs: 0,
  pageLoadTtfbMs: 0,
  pageLoadDomContentLoadedMs: 0,
  pageLoadTransferBytes: 0,
  pageLoadEncodedBytes: 0,
  pageLoadDecodedBytes: 0,
  pageLoadRedirects: 0,
  javascriptErrors: 0,
  resourceErrors: 0,
  longTasks: 0,
  longTaskDurationMs: 0,
  resourceCount: 0,
  resourceTransferBytes: 0,
  resourceCachedCount: 0,
  webVitals: {},
  lastPath: null,
  lastStatus: null,
};
const database: DatabaseMetric = {
  count: 0,
  active: 0,
  failures: 0,
  totalDurationMs: 0,
  samples: [],
  lastDurationMs: null,
  lastCompletedAt: null,
  operations: {},
  lastErrorAt: null,
};
let lifecycle: 'starting' | 'running' | 'stopping' = 'starting';
const subscribers = new Set<Response>();
let previousCpu = process.cpuUsage();
let previousCpuAt = performance.now();

function newDurationMetric(): DurationMetric {
  return {
    count: 0,
    totalDurationMs: 0,
    samples: [],
    lastDurationMs: null,
    lastCompletedAt: null,
  };
}

function addSample(metric: DurationMetric, durationMs: number) {
  metric.count += 1;
  metric.totalDurationMs += durationMs;
  metric.samples.push(durationMs);
  if (metric.samples.length > MAX_SAMPLES) metric.samples.shift();
  metric.lastDurationMs = Number(durationMs.toFixed(2));
  metric.lastCompletedAt = new Date().toISOString();
}

function percentile(samples: number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  return Number(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)].toFixed(2));
}

function durationSnapshot(metric: DurationMetric) {
  return {
    count: metric.count,
    averageMs: metric.count ? Number((metric.totalDurationMs / metric.count).toFixed(2)) : 0,
    p50Ms: percentile(metric.samples, 0.5) ?? 0,
    p95Ms: percentile(metric.samples, 0.95) ?? 0,
    p99Ms: percentile(metric.samples, 0.99) ?? 0,
    lastDurationMs: metric.lastDurationMs,
    lastCompletedAt: metric.lastCompletedAt,
  };
}

function normalisePath(path: string) {
  return path
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function endpointKey(req: Request) {
  return `${req.method} ${normalisePath(req.path)}`;
}

function operationName(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 42) || 'query';
}

function recordRate(key: string, now = Date.now()) {
  let counter = rateCounters.get(key);
  if (!counter) {
    counter = { buckets: Array.from({ length: 60 }, () => 0), seconds: Array.from({ length: 60 }, () => null), startedAt: now };
    rateCounters.set(key, counter);
  }
  const second = Math.floor(now / 1000);
  const bucket = second % 60;
  if (counter.seconds[bucket] !== second) {
    counter.seconds[bucket] = second;
    counter.buckets[bucket] = 0;
  }
  counter.buckets[bucket] += 1;
}

function ratePerSecond(key: string, now = Date.now()): number {
  const counter = rateCounters.get(key);
  if (!counter || counter.startedAt === null) return 0;
  const windowStart = Math.max(counter.startedAt, now - 60_000);
  const firstSecond = Math.floor(windowStart / 1000);
  const currentSecond = Math.floor(now / 1000);
  let count = 0;
  for (let second = firstSecond; second <= currentSecond; second += 1) {
    const bucket = second % 60;
    if (counter.seconds[bucket] === second) count += counter.buckets[bucket];
  }
  return Number((count / Math.max(1, (now - windowStart) / 1000)).toFixed(2));
}

function cpuSnapshot() {
  const now = performance.now();
  const elapsedMs = Math.max(1, now - previousCpuAt);
  const current = process.cpuUsage();
  const userMs = Math.max(0, current.user - previousCpu.user) / 1000;
  const systemMs = Math.max(0, current.system - previousCpu.system) / 1000;
  previousCpu = current;
  previousCpuAt = now;
  return {
    userMs: Number(userMs.toFixed(2)),
    systemMs: Number(systemMs.toFixed(2)),
    percent: Number(((userMs + systemMs) / elapsedMs * 100).toFixed(2)),
  };
}

function eventLoopSnapshot() {
  const value = (nanoseconds: number) => Number.isFinite(nanoseconds) ? Number((nanoseconds / 1_000_000).toFixed(2)) : 0;
  return {
    meanMs: Number.isFinite(eventLoop.mean) ? value(eventLoop.mean) : 0,
    p50Ms: value(eventLoop.percentile(50)),
    p95Ms: value(eventLoop.percentile(95)),
    maxMs: value(eventLoop.max),
  };
}

export const metrics = {
  markRunning() {
    lifecycle = 'running';
  },
  markStopping() {
    lifecycle = 'stopping';
  },
  requestStarted(req: Request) {
    const key = endpointKey(req);
    const current = endpoints.get(key) ?? {
      ...newDurationMetric(),
      active: 0,
      failures: 0,
      serverErrors: 0,
      clientErrors: 0,
      statusCodes: {},
      lastStatus: null,
    };
    current.active += 1;
    endpoints.set(key, current);
    return { key, startedAt: process.hrtime.bigint() };
  },
  requestCompleted(key: string, status: number, started: bigint) {
    const current = endpoints.get(key);
    if (!current) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    current.active = Math.max(0, current.active - 1);
    addSample(current, durationMs);
    recordRate('http:all');
    recordRate('http:' + key);
    current.failures += status >= 400 ? 1 : 0;
    current.serverErrors += status >= 500 ? 1 : 0;
    current.clientErrors += status >= 400 && status < 500 ? 1 : 0;
    const statusKey = String(status);
    current.statusCodes[statusKey] = (current.statusCodes[statusKey] ?? 0) + 1;
    current.lastStatus = status;
  },
  databaseQueryStarted(operation: string) {
    database.active += 1;
    const key = operationName(operation);
    database.operations[key] = (database.operations[key] ?? 0) + 1;
    const startedAt = process.hrtime.bigint();
    databaseOperationTimers.set(startedAt, key);
    return startedAt;
  },
  databaseQueryCompleted(started: bigint, failed = false) {
    database.active = Math.max(0, database.active - 1);
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    addSample(database, durationMs);
    recordRate('database:all');
    const operation = databaseOperationTimers.get(started);
    databaseOperationTimers.delete(started);
    if (operation) {
      let operationMetric = databaseOperationDurations.get(operation);
      if (!operationMetric) operationMetric = newDurationMetric();
      addSample(operationMetric, durationMs);
      databaseOperationDurations.set(operation, operationMetric);
      if (failed) databaseOperationFailures.set(operation, (databaseOperationFailures.get(operation) ?? 0) + 1);
      recordRate('database:' + operation);
    }
    if (failed) {
      database.failures += 1;
      database.lastErrorAt = new Date().toISOString();
    }
  },
  recordFrontendRequest(path: string, status: number, durationMs: number) {
    this.recordFrontendEvent({ kind: 'api_request', path, status, durationMs });
  },
  recordFrontendEvent(event: FrontendMetricEvent) {
    const path = event.path ? normalisePath(event.path) : null;
    const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs ?? 0) : 0;
    frontend.lastPath = path ?? frontend.lastPath;
    frontend.lastStatus = Number.isInteger(event.status) ? event.status ?? null : frontend.lastStatus;
    if (event.kind === 'api_request') {
      addSample(frontend, durationMs);
      recordRate('frontend:all');
      frontend.failures += (event.status ?? 0) === 0 || (event.status ?? 0) >= 400 ? 1 : 0;
      return;
    }
    if (event.kind === 'page_load') {
      frontend.pageLoads += 1;
      frontend.pageLoadDurationMs += durationMs;
      frontend.pageLoadTtfbMs += Number(event.metadata?.ttfbMs ?? 0);
      frontend.pageLoadDomContentLoadedMs += Number(event.metadata?.domContentLoadedMs ?? 0);
      frontend.pageLoadTransferBytes += Number(event.metadata?.transferBytes ?? 0);
      frontend.pageLoadEncodedBytes += Number(event.metadata?.encodedBytes ?? 0);
      frontend.pageLoadDecodedBytes += Number(event.metadata?.decodedBytes ?? 0);
      frontend.pageLoadRedirects += Number(event.metadata?.redirectCount ?? 0);
      return;
    }
    if (event.kind === 'navigation') {
      frontend.pageViews += 1;
      return;
    }
    if (event.kind === 'web_vital' && event.name) {
      const vital = frontend.webVitals[event.name] ?? newDurationMetric();
      addSample(vital, Number.isFinite(event.value) ? event.value ?? 0 : durationMs);
      frontend.webVitals[event.name] = vital;
      return;
    }
    if (event.kind === 'js_error') {
      frontend.javascriptErrors += 1;
      return;
    }
    if (event.kind === 'resource_error') {
      frontend.resourceErrors += 1;
      return;
    }
    if (event.kind === 'long_task') {
      frontend.longTasks += 1;
      frontend.longTaskDurationMs += durationMs;
      return;
    }
    if (event.kind === 'resource_summary') {
      frontend.resourceCount += Math.max(0, Number(event.metadata?.resourceCount ?? 0));
      frontend.resourceTransferBytes += Math.max(0, Number(event.metadata?.transferBytes ?? 0));
      frontend.resourceCachedCount += Math.max(0, Number(event.metadata?.cachedCount ?? 0));
    }
  },
  subscribe(res: Response, snapshot: () => Promise<unknown>) {
    let closed = false;
    subscribers.add(res);
    const send = async () => {
      if (closed) return;
      try {
        res.write(`event: metrics\ndata: ${JSON.stringify(await snapshot())}\n\n`);
      } catch {
        closed = true;
      }
    };
    void send();
    const interval = setInterval(() => void send(), 2000);
    return () => {
      closed = true;
      clearInterval(interval);
      subscribers.delete(res);
    };
  },
  closeStreams() {
    for (const res of subscribers) res.end();
    subscribers.clear();
  },
  snapshot(databaseSnapshot: unknown) {
    const cpu = cpuSnapshot();
    const endpointData = Object.fromEntries([...endpoints.entries()].map(([path, item]) => [path, {
      active: item.active,
      failures: item.failures,
      serverErrors: item.serverErrors,
      clientErrors: item.clientErrors,
      ratePerSecond: ratePerSecond('http:' + path),
      lastStatus: item.lastStatus,
      statusCodes: item.statusCodes,
      ...durationSnapshot(item),
    }]));
    const endpointValues = [...endpoints.values()];
    const activeRequests = endpointValues.reduce((total, item) => total + item.active, 0);
    const requestTotals = endpointValues.reduce((total, item) => total + item.count, 0);
    const serverErrors = endpointValues.reduce((total, item) => total + item.serverErrors, 0);
    const clientErrors = endpointValues.reduce((total, item) => total + item.clientErrors, 0);
    const statusCodes = endpointValues.reduce<Record<string, number>>((all, item) => {
      Object.entries(item.statusCodes).forEach(([status, count]) => { all[status] = (all[status] ?? 0) + count; });
      return all;
    }, {});
    const requestDuration = newDurationMetric();
    endpointValues.forEach((item) => {
      requestDuration.totalDurationMs += item.totalDurationMs;
      requestDuration.samples.push(...item.samples);
    });
    requestDuration.samples = requestDuration.samples.slice(-MAX_SAMPLES);
    requestDuration.count = requestTotals;
    const uptimeSeconds = process.uptime();
    return {
      observedAt: new Date().toISOString(),
      lifecycle,
      startedAt,
      uptimeSeconds: Number(uptimeSeconds.toFixed(1)),
      process: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cpu,
        memoryRssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
        externalBytes: process.memoryUsage().external,
        arrayBuffersBytes: process.memoryUsage().arrayBuffers,
        systemMemoryTotalBytes: os.totalmem(),
        systemMemoryFreeBytes: os.freemem(),
        availableParallelism: os.availableParallelism(),
        eventLoop: eventLoopSnapshot(),
      },
      requests: {
        total: requestTotals,
        ratePerSecond: ratePerSecond('http:all'),
        active: activeRequests,
        failures: serverErrors + clientErrors,
        serverErrors,
        clientErrors,
        statusCodes,
        ...durationSnapshot(requestDuration),
        endpoints: endpointData,
      },
      frontend: {
        requests: frontend.count,
        ratePerSecond: ratePerSecond('frontend:all'),
        failures: frontend.failures,
        averageDurationMs: frontend.count ? Number((frontend.totalDurationMs / frontend.count).toFixed(2)) : 0,
        ...durationSnapshot(frontend),
        pageViews: frontend.pageViews,
        pageLoads: frontend.pageLoads,
        pageLoadAverageMs: frontend.pageLoads ? Number((frontend.pageLoadDurationMs / frontend.pageLoads).toFixed(2)) : 0,
        pageLoadTtfbAverageMs: frontend.pageLoads ? Number((frontend.pageLoadTtfbMs / frontend.pageLoads).toFixed(2)) : 0,
        pageLoadDomContentLoadedAverageMs: frontend.pageLoads ? Number((frontend.pageLoadDomContentLoadedMs / frontend.pageLoads).toFixed(2)) : 0,
        pageLoadTransferBytes: frontend.pageLoadTransferBytes,
        pageLoadEncodedBytes: frontend.pageLoadEncodedBytes,
        pageLoadDecodedBytes: frontend.pageLoadDecodedBytes,
        pageLoadRedirects: frontend.pageLoadRedirects,
        javascriptErrors: frontend.javascriptErrors,
        resourceErrors: frontend.resourceErrors,
        longTasks: frontend.longTasks,
        longTaskAverageMs: frontend.longTasks ? Number((frontend.longTaskDurationMs / frontend.longTasks).toFixed(2)) : 0,
        resources: {
          count: frontend.resourceCount,
          transferBytes: frontend.resourceTransferBytes,
          cachedCount: frontend.resourceCachedCount,
        },
        webVitals: Object.fromEntries(Object.entries(frontend.webVitals).map(([name, item]) => [name, durationSnapshot(item)])),
        lastPath: frontend.lastPath,
        lastStatus: frontend.lastStatus,
      },
      database: {
        ...(databaseSnapshot && typeof databaseSnapshot === 'object' ? databaseSnapshot : {}),
        ...durationSnapshot(database),
        ratePerSecond: ratePerSecond('database:all'),
        active: database.active,
        failures: database.failures,
        operations: database.operations,
        operationMetrics: Object.fromEntries([...databaseOperationDurations.entries()].map(([name, metric]) => [name, {
          ...durationSnapshot(metric),
          ratePerSecond: ratePerSecond('database:' + name),
          failures: databaseOperationFailures.get(name) ?? 0,
        }])),
        lastErrorAt: database.lastErrorAt,
        readiness: databaseSnapshot,
      },
    };
  },
};
