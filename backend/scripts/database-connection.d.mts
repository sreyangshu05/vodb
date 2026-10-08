import type { PoolConfig } from 'pg';

export function createMaintenanceDatabaseConfig(
  env: NodeJS.ProcessEnv,
  max: number,
): PoolConfig;
