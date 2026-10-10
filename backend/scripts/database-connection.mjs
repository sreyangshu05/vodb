const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_HOSTS.has(normalized) || normalized.endsWith('.localhost');
}

export function createMaintenanceDatabaseConfig(env, max) {
  const nodeEnv = env.NODE_ENV || 'development';
  const connectionString = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
  if (connectionString) {
    const url = new URL(connectionString);
    if (nodeEnv !== 'production' && !isLocalHost(url.hostname) && env.ALLOW_REMOTE_DEVELOPMENT_SERVICES !== 'true') {
      throw new Error('Remote database access is disabled outside production; verify the target is non-production and set ALLOW_REMOTE_DEVELOPMENT_SERVICES=true to proceed.');
    }
    if (!env.DIRECT_DATABASE_URL && url.hostname.includes('-pooler')) {
      throw new Error('Set DIRECT_DATABASE_URL to the direct database connection string before running this script.');
    }

    const remote = !isLocalHost(url.hostname);
    return {
      connectionString,
      ...(remote ? { ssl: { rejectUnauthorized: true } } : {}),
      max,
      connectionTimeoutMillis: 10000,
    };
  }

  const host = env.POSTGRES_HOST || '127.0.0.1';
  const remote = !isLocalHost(host);
  if (nodeEnv !== 'production' && remote && env.ALLOW_REMOTE_DEVELOPMENT_SERVICES !== 'true') {
    throw new Error('Remote database access is disabled outside production; verify the target is non-production and set ALLOW_REMOTE_DEVELOPMENT_SERVICES=true to proceed.');
  }
  if (remote && env.POSTGRES_SSL !== 'true') {
    throw new Error('POSTGRES_SSL=true is required for remote database connections.');
  }

  return {
    host,
    port: Number(env.POSTGRES_PORT || 5433),
    database: env.POSTGRES_DB || 'appdb',
    user: env.POSTGRES_USER || 'postgres',
    password: env.POSTGRES_PASSWORD,
    ssl: env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false,
    max,
    connectionTimeoutMillis: 10000,
  };
}
