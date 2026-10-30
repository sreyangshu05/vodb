import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(scriptDirectory, '..');
dotenv.config({ path: resolve(backendDirectory, '.env') });

const preferredPort = Number(process.env.PORT || 4000);
const databaseMode = process.env.VODB_DEV_DATABASE_MODE || 'local';

function isPortAvailable(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolvePromise(false);
        return;
      }
      rejectPromise(error);
    });
    probe.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      probe.close((error) => error ? rejectPromise(error) : resolvePromise(true));
    });
  });
}

async function ensurePortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid development API port: ${port}.`);
  }
  if (!await isPortAvailable(port)) {
    throw new Error(`Development API port ${port} is already in use. Stop the existing process; the frontend is configured to use this exact port.`);
  }
}

async function setFrontendApiBase(port) {
  const frontendEnvPath = resolve(backendDirectory, '../frontend/.env.development.local');
  let content = '';
  try {
    content = await readFile(frontendEnvPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = content ? content.split(/\r?\n/) : [];
  while (lines.at(-1) === '') lines.pop();
  const apiBaseLine = `VITE_API_BASE=http://localhost:${port}/api/v1`;
  const existingIndex = lines.findIndex((line) => /^\s*VITE_API_BASE\s*=/.test(line));
  if (existingIndex >= 0) lines[existingIndex] = apiBaseLine;
  else lines.push(apiBaseLine);

  await writeFile(frontendEnvPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

async function main() {
  try {
    if (!['local', 'configured'].includes(databaseMode)) {
      throw new Error('VODB_DEV_DATABASE_MODE must be either "local" or "configured".');
    }
    await ensurePortAvailable(preferredPort);
    await setFrontendApiBase(preferredPort);
  } catch (error) {
    console.error(`Could not prepare the local backend: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const childEnvironment = { ...process.env, PORT: String(preferredPort) };
  if (databaseMode === 'local') {
    childEnvironment.DATABASE_URL = '';
    childEnvironment.DIRECT_DATABASE_URL = '';
  }

  console.log(`Starting Voice Of Digi Bengal backend at http://localhost:${preferredPort} with ${databaseMode} PostgreSQL.`);
  console.log('Frontend API base saved to frontend/.env.development.local. Restart Vite if it is already running.');

  const child = spawn(process.execPath, [
    '--watch',
    '--import', 'tsx',
    'src/server.ts',
  ], {
    cwd: backendDirectory,
    env: childEnvironment,
    stdio: 'inherit',
  });

  await new Promise((resolvePromise) => {
    child.once('error', (error) => {
      console.error(`Could not start the backend development server: ${error.message}`);
      process.exitCode = 1;
      resolvePromise();
    });

    child.once('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolvePromise();
    });
  });
}

main().catch((error) => {
  console.error(`Could not start the backend development server: ${error.message}`);
  process.exitCode = 1;
});
