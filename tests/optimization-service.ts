import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The port the real Python optimization service listens on for Phase 6 acceptance (the only test
 * that starts it for real, rather than standing in for it with a scripted fetch). tests/ports.test.ts
 * checks nothing else in the tests uses this port.
 */
export const OPTIMIZATION_SERVICE_PORT = 18_891;
export const OPTIMIZATION_SERVICE_BASE_URL = `http://127.0.0.1:${OPTIMIZATION_SERVICE_PORT}`;

const SERVICE_ROOT = join(__dirname, '..', 'services', 'optimization');

function venvPython(): string {
  const windows = join(SERVICE_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(windows)) return windows;
  const posix = join(SERVICE_ROOT, '.venv', 'bin', 'python');
  if (existsSync(posix)) return posix;
  throw new Error(
    `No Python virtualenv found at ${SERVICE_ROOT}/.venv - set it up (see services/optimization) before running this test.`,
  );
}

export interface OptimizationService {
  baseUrl: string;
  close: () => Promise<void>;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > stop) {
      throw new Error(`The optimization service did not answer /health within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Starts the actual FastAPI/OR-Tools service (services/optimization/app), not a stand-in for it -
 * this is what makes the Phase 6 acceptance test a real end-to-end check of the Python side, the
 * TypeScript orchestration (runBatchOptimization) and the HTTP boundary between them together. Stop
 * it with close().
 */
export async function startOptimizationService(timeoutMs = 20_000): Promise<OptimizationService> {
  const child: ChildProcess = spawn(
    venvPython(),
    [
      '-m',
      'uvicorn',
      'app.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(OPTIMIZATION_SERVICE_PORT),
    ],
    { cwd: SERVICE_ROOT, stdio: 'pipe' },
  );

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`The optimization service exited early (code ${code}).\n${stderr}`));
      }
    });
  });

  try {
    await Promise.race([waitForHealth(OPTIMIZATION_SERVICE_BASE_URL, timeoutMs), exited]);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    baseUrl: OPTIMIZATION_SERVICE_BASE_URL,
    close: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
