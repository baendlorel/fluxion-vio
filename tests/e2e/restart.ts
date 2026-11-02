/**
 * End-to-end in-place restart test: a real child process whose RSS crosses the
 * `restartMemoryMB` threshold is re-executed with the same PID.
 *
 * The child writes its PID to a boot-marker file every time the entry point
 * runs, so two lines with the same PID prove the image was replaced in place.
 * With `DISABLE_EXECVE=1` the runtime pretends `process.execve` does not exist,
 * as on older Node.js, and the option must be ignored with a warning instead.
 *
 *   pnpm tsx tests/e2e/restart.ts
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxion-restart-e2e-'));
const appDir = path.join(root, 'dynamic');
const bootMarker = path.join(root, 'boots.txt');
const indexPath = path.resolve(import.meta.dirname, '../../src/index.ts');

const write = (name: string, body: string) => fs.writeFileSync(path.join(appDir, name), body);

fs.mkdirSync(appDir);

// The entry point lives outside `dir` and uses the `.mts` extension so it is
// ESM: the dynamic files under `dir` are compiled to CJS, which has no
// top-level await.
fs.writeFileSync(
  path.join(root, 'app.mts'),
  `import fs from 'node:fs';
import { fluxion } from ${JSON.stringify(indexPath)};

// Pretend to be an older Node.js, where process.execve does not exist.
if (process.env.DISABLE_EXECVE === '1') {
  Object.defineProperty(process, 'execve', { value: undefined, configurable: true });
}

fs.appendFileSync(process.env.BOOT_MARKER!, process.pid + '\\n');

const baseMB = Math.ceil(process.memoryUsage.rss() / (1024 * 1024));
await fluxion({
  dir: process.env.APP_DIR!,
  host: '127.0.0.1',
  port: Number(process.env.PORT),
  restartMemoryMB: baseMB + 24,
});
`,
);
write('ping.ts', 'export default { type: 0, handler: () => ({ pid: process.pid }) };\n');
// Keep 64MB alive in module state; the reload cache never drops it on its own.
write(
  'grow.ts',
  `const ballast = (globalThis as any);
ballast.__e2eBallast = Buffer.alloc(64 * 1024 * 1024, 1);
export default { type: 0, handler: () => ({ pid: process.pid, rssMB: Math.round(process.memoryUsage.rss() / (1024 * 1024)) }) };\n`,
);

const startChild = async (instanceLog: string, extraEnv: Record<string, string> = {}) => {
  const port = await freePort();
  // Reuse the parent's execArgv so the loader (`tsx`) is set up the same way.
  const child = spawn(process.execPath, [...process.execArgv, path.join(root, 'app.mts')], {
    env: {
      ...process.env,
      BOOT_MARKER: bootMarker,
      APP_DIR: appDir,
      PORT: String(port),
      FLUXION_INSTANCE_LOG: instanceLog,
      ...extraEnv,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return { child, port, url: (name: string) => `http://127.0.0.1:${port}/${name}` };
};

const boots = () => (fs.existsSync(bootMarker) ? fs.readFileSync(bootMarker, 'utf8').trim().split('\n') : []);

const restartKeepsPid = async () => {
  fs.rmSync(bootMarker, { force: true });
  const instanceLog = path.join(root, 'restart.log');
  const { child, url } = await startChild(instanceLog);
  try {
    const firstBoot = await waitFor('the first boot', async () => boots()[0] ?? undefined);
    assert.equal(firstBoot, String(child.pid), 'the first boot should report the child PID');
    await waitFor('the server to accept requests', () => getJson(url('ping.ts')));
    console.log('ok: the child started and served a request');

    const grown = await getJson(url('grow.ts'));
    console.log(`ok: /grow.ts raised RSS to ${grown.rssMB}MB`);

    // The monitor waits out its 5s startup grace, then samples every 10s.
    const secondBoot = await waitFor(
      'a memory-triggered restart',
      async () => (boots().length >= 2 ? boots()[1] : undefined),
      30_000,
    );
    assert.equal(secondBoot, firstBoot, 'the restarted process must keep the same PID');
    console.log(`ok: the entry point ran again in the same process (pid ${secondBoot})`);

    // Same PID, but the heap is fresh: the ballast is gone.
    const after = await waitFor('the server to serve again after the restart', () => getJson(url('ping.ts')));
    assert.equal(after.pid, child.pid, 'the server should be served by the restarted image');
    console.log('ok: the server is listening again in the restarted image');

    const log = fs.readFileSync(instanceLog, 'utf8');
    assert.match(log, /"event":"Restarting"/, 'the log should record the restart');
    assert.match(log, /"reason":"memory"/, 'the log should record the reason');
    assert.equal(log.match(/"event":"FluxionStarted"/g)?.length, 2, 'both images should log their start');
    console.log('ok: the instance log was flushed before execve and reopened afterwards');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
};

const unsupportedRuntimeIgnoresOption = async () => {
  fs.rmSync(bootMarker, { force: true });
  const instanceLog = path.join(root, 'unsupported.log');
  const { child, url } = await startChild(instanceLog, { DISABLE_EXECVE: '1' });
  try {
    await waitFor('the server to accept requests', () => getJson(url('ping.ts')));
    const grown = await getJson(url('grow.ts'));
    console.log(`ok: without process.execve, /grow.ts raised RSS to ${grown.rssMB}MB`);

    // The threshold is well past. Give the monitor more than its 5s startup
    // grace and prove nothing restarted.
    await sleep(6000);
    assert.equal(boots().length, 1, 'the entry point must not run again');
    const after = await getJson(url('ping.ts'));
    assert.equal(after.pid, child.pid, 'the same image should still be serving');

    const log = fs.readFileSync(instanceLog, 'utf8');
    assert.match(log, /"event":"RestartDisabled"/, 'the log should say the option was ignored');
    assert.doesNotMatch(log, /"event":"Restarting"/, 'no restart should be attempted');
    console.log('ok: without process.execve the option was ignored with a RestartDisabled warning');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
};

try {
  await restartKeepsPid();
  await unsupportedRuntimeIgnoresOption();
  console.log('PASS: memory-triggered in-place restart kept the PID, and is skipped when unsupported');
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// The test server in this process would keep the event loop alive; the test is over.
process.exit(process.exitCode ?? 0);
