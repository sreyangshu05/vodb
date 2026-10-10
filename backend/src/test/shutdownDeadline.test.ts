import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, get, type AddressInfo } from 'node:http';
import { scheduleShutdownDeadline } from '../services/shutdownDeadline.js';

test('shutdown deadline closes active connections and invokes the timeout handler', async () => {
  let receivedRequest!: () => void;
  const requestReceived = new Promise<void>((resolve) => { receivedRequest = resolve; });
  let timedOut!: () => void;
  const timeoutReached = new Promise<void>((resolve) => { timedOut = resolve; });
  const server = createServer(() => receivedRequest());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const requestClosed = new Promise<void>((resolve) => {
    const activeRequest = get(`http://127.0.0.1:${address.port}/held`, () => {});
    activeRequest.once('error', () => resolve());
  });
  await requestReceived;

  let timeoutCount = 0;
  const cancel = scheduleShutdownDeadline(server, 25, () => {
    timeoutCount += 1;
    timedOut();
  });
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));

  await Promise.all([timeoutReached, serverClosed, requestClosed]);
  cancel();
  assert.equal(timeoutCount, 1);
});

test('completed shutdown cancels its deadline', async () => {
  let timedOut = false;
  const server = createServer();
  const cancel = scheduleShutdownDeadline(server, 20, () => { timedOut = true; });
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timedOut, false);
});
