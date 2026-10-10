import type { Server } from 'node:http';

export function scheduleShutdownDeadline(server: Server, timeoutMs: number, onTimeout: () => void): () => void {
  const timeout = setTimeout(() => {
    server.closeAllConnections();
    onTimeout();
  }, timeoutMs);
  timeout.unref();
  return () => clearTimeout(timeout);
}
