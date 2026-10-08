const UNAVAILABLE_SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03']);
const DATABASE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const DATABASE_CONFIGURATION_SQLSTATES = new Set(['28P01', '3D000']);

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function isDatabaseUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  if (code) {
    return code.startsWith('08') || UNAVAILABLE_SQLSTATES.has(code) || DATABASE_NETWORK_CODES.has(code);
  }

  if (!(error instanceof Error)) return false;
  return /could not connect to server|connection terminated unexpectedly|timeout exceeded when trying to connect/i.test(error.message);
}

export function isDatabaseConfigurationError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && DATABASE_CONFIGURATION_SQLSTATES.has(code);
}
