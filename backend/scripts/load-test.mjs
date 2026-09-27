const baseUrl = process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:4000/api/v1';
const path = process.env.LOAD_TEST_PATH ?? '/health';
const requests = Number.parseInt(process.env.LOAD_TEST_REQUESTS ?? '100', 10);
const concurrency = Number.parseInt(process.env.LOAD_TEST_CONCURRENCY ?? '10', 10);

if (!Number.isInteger(requests) || requests < 1 || requests > 10000) {
  throw new Error('LOAD_TEST_REQUESTS must be an integer between 1 and 10000.');
}

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > requests) {
  throw new Error('LOAD_TEST_CONCURRENCY must be an integer between 1 and LOAD_TEST_REQUESTS.');
}

const url = new URL(path.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`).toString();
const durations = [];
const statuses = new Map();
let nextRequest = 0;

async function runWorker() {
  while (true) {
    const requestNumber = nextRequest;
    nextRequest += 1;
    if (requestNumber >= requests) return;

    const startedAt = performance.now();
    let status = 'network_error';
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      status = String(response.status);
      await response.arrayBuffer();
    } catch {
      // Keep the request in the report while allowing other workers to finish.
    }
    durations.push(performance.now() - startedAt);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
const elapsedMs = performance.now() - startedAt;
durations.sort((left, right) => left - right);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)];
const nonSuccess = [...statuses.keys()].filter((status) => status !== '200');

console.log(JSON.stringify({
  url,
  requests,
  concurrency,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  requestsPerSecond: Number((requests / (elapsedMs / 1000)).toFixed(2)),
  latencyMs: {
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    max: Number(Math.max(...durations).toFixed(2)),
  },
  statuses: Object.fromEntries([...statuses.entries()].sort()),
}, null, 2));

if (nonSuccess.length > 0) process.exitCode = 1;
