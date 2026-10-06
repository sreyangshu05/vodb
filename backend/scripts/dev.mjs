import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(scriptDirectory, '..');
dotenv.config({ path: resolve(backendDirectory, '.env') });

const preferredPort = Number(process.env.PORT || 4000);

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

function isBackendAlreadyRunning(port) {
  return new Promise((resolvePromise) => {
    const request = get(`http://127.0.0.1:${port}/api/v1/health`, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.once('end', () => {
        try {
          resolvePromise(response.statusCode === 200 && JSON.parse(body).service === 'voice-of-digi-bengal-backend');
        } catch {
          resolvePromise(false);
        }
      });
    });

    request.setTimeout(900, () => request.destroy());
    request.once('error', () => resolvePromise(false));
  });
}

async function findAvailablePort() {
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    if (await isPortAvailable(port)) return { port, alreadyRunning: false };
    if (port !== preferredPort && await isBackendAlreadyRunning(port)) {
      return { port, alreadyRunning: true };
    }
  }
  throw new Error(`No free development port found between ${preferredPort} and ${preferredPort + 49}.`);
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
  let port;
  let alreadyRunning;
  try {
    ({ port, alreadyRunning } = await findAvailablePort());
    await setFrontendApiBase(port);
  } catch (error) {
    console.error(`Could not prepare the local backend: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (alreadyRunning) {
    console.log(`Voice Of Digi Bengal backend is already running at http://localhost:${port}. Reusing it.`);
    return;
  }

  process.env.PORT = String(port);
  console.log(`Starting Voice Of Digi Bengal backend at http://localhost:${port}.`);
  console.log('Frontend API base saved to frontend/.env.development.local. Restart Vite if it is already running.');

  const child = spawn(process.execPath, [
    '--watch',
    '--import', 'tsx',
    'src/server.ts',
  ], {
    cwd: backendDirectory,
    env: process.env,
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
