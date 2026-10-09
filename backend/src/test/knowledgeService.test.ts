import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedAiResponse } from '../services/knowledgeService.js';

test('AI provider response parser accepts bounded JSON and rejects invalid media types or oversized bodies', async () => {
  const valid = new Response('{"choices":[]}', { headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await readBoundedAiResponse(valid), { choices: [] });

  const invalidType = new Response('<html>provider error</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(readBoundedAiResponse(invalidType));

  const oversized = new Response(JSON.stringify({ output: 'x'.repeat(129 * 1024) }), {
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(readBoundedAiResponse(oversized), /exceeded the configured limit/);
});
