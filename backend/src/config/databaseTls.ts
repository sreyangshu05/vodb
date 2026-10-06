export function assertProductionDatabaseTls(databaseUrl: string | undefined, postgresSsl: boolean): void {
  if (!databaseUrl) {
    if (!postgresSsl) throw new Error('POSTGRES_SSL must be enabled for production database connections.');
    return;
  }

  const sslMode = new URL(databaseUrl).searchParams.get('sslmode')?.toLowerCase();
  if (!sslMode || !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('DATABASE_URL must explicitly require TLS in production (sslmode=require or stronger).');
  }
}