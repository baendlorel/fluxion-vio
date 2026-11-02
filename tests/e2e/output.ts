/**
 * End-to-end test for `logOutputFile`: a real child process whose stdout and
 * stderr are redirected to a file.
 *
 * The handler prints with both `console.log` and `console.error`. The child's
 * real stdout/stderr are piped back here, so the test can prove the lines reach
 * the file and *not* the terminal. The second case restarts the process in place
 * to prove the file is reopened in append mode after `execve`.
 *
 *   pnpm tsx tests/e2e/output.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Ask the OS for a port that is free right now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not obtain a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`);
};

const getJson = async (url: string) => {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxion-output-e2e-'));
const appDir = path.join(root, 'dynamic');
const bootMarker = path.join(root, 'boots.txt');
const indexPath = path.resolve(import.meta.dirname, '../../src/index.ts');
// `logOutputFile` is given as `logs/server.log` (relative), so each child's cwd
// decides where it lands. It has to be inside the package for `tsx` to resolve
// the source's `@/` alias; `node_modules/.cache` is gitignored.
const childCwd = path.join(path.resolve(import.meta.dirname, '../..'), 'node_modules', '.cache', 'output-e2e');
const logPath = path.join(childCwd, 'logs', 'server.log');
fs.mkdirSync(childCwd, { recursive: true });

const write = (name: string, body: string) => fs.writeFileSync(path.join(appDir, name), body);

fs.mkdirSync(appDir);

// The entry point lives outside `dir` and uses `.mts` for top-level await.
fs.writeFileSync(
  path.join(root, 'app.mts'),
  `import fs from 'node:fs';
import { fluxion } from ${JSON.stringify(indexPath)};

fs.appendFileSync(process.env.BOOT_MARKER!, process.pid + '\\n');

const baseMB = Math.ceil(process.memoryUsage.rss() / (1024 * 1024));
await fluxion({
  dir: process.env.APP_DIR!,
  host: '127.0.0.1',
  port: Number(process.env.PORT),
  // Relative on purpose: the child runs with its cwd set to the temp root.
  logOutputFile: 'logs/server.log',
  restartMemoryMB: process.env.TRIGGER_RESTART === '1' ? baseMB + 24 : false,
});
`,
);

// Handler output must be split across both streams, and both must land in the file.
write(
  'ping.ts',
  `export default {
  type: 0,
  handler: () => {
    console.log('handler-stdout');
    console.error('handler-stderr');
    return { pid: process.pid };
  },
};
`,
);
write(
  'grow.ts',
  `const ballast = (globalThis as any);
ballast.__e2eBallast = Buffer.alloc(64 * 1024 * 1024, 1);
export default { type: 0, handler: () => ({ pid: process.pid }) };
`,
);

const startChild = async (extraEnv: Record<string, string> = {}) => {
  const port = await freePort();
  const child = spawn(process.execPath, [...process.execArgv, path.join(root, 'app.mts')], {
    cwd: childCwd,
    env: {
      ...process.env,
      BOOT_MARKER: bootMarker,
      APP_DIR: appDir,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // What the child would have shown on the terminal; the redirect must keep it empty of our output.
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    return { stdout, stderr };
  };

  return { child, port, url: (name: string) => `http://127.0.0.1:${port}/${name}`, stop };
};

const boots = () => (fs.existsSync(bootMarker) ? fs.readFileSync(bootMarker, 'utf8').trim().split('\n') : []);

const redirectsBothStreams = async () => {
  fs.rmSync(bootMarker, { force: true });
  fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  const { child, url, stop } = await startChild();
  try {
    await waitFor('the log file to appear', async () =>
      fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').length > 0 ? true : undefined,
    );
    await waitFor('the server to accept requests', () => getJson(url('ping.ts')));
    await waitFor('the handler output to be flushed', async () => {
      const log = fs.readFileSync(logPath, 'utf8');
      return log.includes('handler-stderr') ? true : undefined;
    });
    console.log('ok: console.log / console.error from a handler reached the log file');

    const { stdout, stderr } = await stop();
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /"event":"FluxionStarted"/, 'the framework log should be in the file');
    assert.match(log, /handler-stdout/, 'stdout should be in the file');
    assert.match(log, /handler-stderr/, 'stderr should be in the file');
    assert.match(log, /"event":"ShuttingDown"/, 'the shutdown log should be flushed on SIGTERM');
    assert.doesNotMatch(stdout, /FluxionStarted|handler-stdout/, 'nothing should reach the real stdout');
    assert.doesNotMatch(stderr, /handler-stderr/, 'nothing should reach the real stderr');
    console.log('ok: the terminal saw none of it, and SIGTERM flushed the file');
  } finally {
    child.kill('SIGKILL');
  }
};

const reopensAfterInPlaceRestart = async () => {
  fs.rmSync(bootMarker, { force: true });
  fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  const { child, url, stop } = await startChild({ TRIGGER_RESTART: '1' });
  try {
    await waitFor('the server to accept requests', () => getJson(url('ping.ts')));
    await getJson(url('grow.ts'));

    const secondBoot = await waitFor(
      'a memory-triggered restart',
      async () => (boots().length >= 2 ? boots()[1] : undefined),
      30_000,
    );
    assert.equal(secondBoot, String(child.pid), 'the restarted process must keep the same PID');
    await waitFor('the restarted image to serve again', () => getJson(url('ping.ts')));
    await waitFor('handler output after the restart', async () => {
      const log = fs.readFileSync(logPath, 'utf8');
      return log.match(/handler-stdout/g)?.length === 2 ? true : undefined;
    });

    await stop();
    const log = fs.readFileSync(logPath, 'utf8');
    assert.equal(
      log.match(/"event":"FluxionStarted"/g)?.length,
      2,
      'both images should log their start into the same file',
    );
    assert.equal(log.match(/handler-stdout/g)?.length, 2, 'the file should be appended to, not truncated');
    assert.equal(log.match(/handler-stderr/g)?.length, 2, 'stderr should also survive the restart');
    console.log('ok: the log file was appended to across an in-place restart');
  } finally {
    child.kill('SIGKILL');
  }
};

try {
  await redirectsBothStreams();
  await reopensAfterInPlaceRestart();
  console.log('PASS: logOutputFile redirected stdout/stderr and survived an in-place restart');
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(childCwd, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);
