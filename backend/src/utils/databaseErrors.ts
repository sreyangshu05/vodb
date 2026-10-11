const UNAVAILABLE_SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03']);
const DATABASE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  // Node can report EACCES when the OS denies a database socket connection.
  'EACCES',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const DATABASE_CONFIGURATION_SQLSTATES = new Set(['28P01', '3D000']);

function errorCode(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<object>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function isDatabaseUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  if (code) {
    return code.startsWith('08') || UNAVAILABLE_SQLSTATES.has(code) || DATABASE_NETWORK_CODES.has(code);
  }

  let current = error;
  const visited = new Set<object>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error && /could not connect to server|connection terminated unexpectedly|connection terminated due to connection timeout|timeout exceeded when trying to connect/i.test(current.message)) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export function isDatabaseConfigurationError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && DATABASE_CONFIGURATION_SQLSTATES.has(code);
}
