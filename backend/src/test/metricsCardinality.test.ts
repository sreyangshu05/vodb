import assert from 'node:assert/strict';
import test from 'node:test';
import { metrics } from '../services/metricsService.js';

test('frontend web-vital metric names are restricted to the supported set', () => {
  metrics.recordFrontendEvent({ kind: 'web_vital', name: 'unbounded-attacker-controlled-name', value: 1 });
  metrics.recordFrontendEvent({ kind: 'web_vital', name: 'LCP', value: 250 });

  const webVitals = metrics.snapshot({}).frontend.webVitals;
  assert.deepEqual(Object.keys(webVitals), ['LCP']);
  assert.equal(webVitals.LCP.count, 1);
});
