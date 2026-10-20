import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/router/index.js';
import { defineFluxionOptions } from '../src/defines/options.js';
import { createLogger } from '../src/common/logger.js';
import { createServer } from '../src/http/server.js';
import type { FluxionContext } from '../src/types.js';
import type http from 'node:http';
import type https from 'node:https';

const servers: Array<http.Server | https.Server> = [];
const tempRoots: string[] = [];
let portCursor = 30_000;

const nextPort = () => portCursor++;

const closeServer = (server: http.Server | https.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const requestJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
};

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxion-lazy-test-'));
  tempRoots.push(dir);
  return dir;
};

const writeApi = (dir: string, relativePath: string, body: string) => {
  const file = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

const makeContext = (dir: string, port = nextPort()) => {
  const options = defineFluxionOptions({
    dir,
    host: '127.0.0.1',
    port,
    apiInclude: ['**/*.ts'],
    logger: () => {},
  });
  const cx = { options } as FluxionContext;
  cx.logger = createLogger(cx);
  cx.router = createRouter(cx);
  return cx;
};

const startWorkerServer = async (cx: FluxionContext) => {
  const server = await createServer(cx);
  servers.push(server);
  return server;
};

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('lazy route — empty start', () => {
  test('returns undefined for missing files and directories', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    expect(await cx.router(new URL('http://local/anything.ts'))).toBeUndefined();
    expect(await cx.router(new URL('http://local/'))).toBeUndefined();
  });

  test('returns 404 on HTTP request before any file exists', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);
    await startWorkerServer(cx);

    const res = await requestJson(`http://127.0.0.1:${cx.options.port}/hello.ts`);
    expect(res.status).toBe(404);
  });
});

describe('lazy route — no cache', () => {
  test('loads a fresh module on every call', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    writeApi(dir, 'greeting.ts', "exports.default = { type: 0, handler: () => ({ msg: 'hello' }) };\n");

    const get1 = await cx.router(new URL('http://local/greeting.ts'));
    expect(get1).toBeDefined();
    expect(get1!.handler).toBeTypeOf('function');

    // Re-reads the file, so a new module object each time
    const get2 = await cx.router(new URL('http://local/greeting.ts'));
    expect(get2).toBeDefined();
    expect(get2).not.toBe(get1);
  });

  test('picks up file changes without an mtime comparison', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    // Write initial version
    writeApi(dir, 'counter.ts', 'exports.default = { type: 0, handler: () => ({ value: 1 }) };\n');

    // Verify initial response
    await startWorkerServer(cx);
    expect(await requestJson(`http://127.0.0.1:${cx.options.port}/counter.ts`)).toEqual({
      status: 200,
      body: { value: 1 },
    });

    // Update file content
    writeApi(dir, 'counter.ts', 'exports.default = { type: 0, handler: () => ({ value: 2 }) };\n');

    // Resolve re-reads the file from disk
    const module2 = await cx.router(new URL('http://local/counter.ts'));
    expect(module2).toBeDefined();

    // Response should now reflect the new version
    expect(await requestJson(`http://127.0.0.1:${cx.options.port}/counter.ts`)).toEqual({
      status: 200,
      body: { value: 2 },
    });
  });

  test('re-evaluates module state on every request', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    writeApi(dir, 'cachecheck.ts', 'exports.default = { type: 0, handler: () => ({ n: Math.random() }) };\n');

    const m1 = await cx.router(new URL('http://local/cachecheck.ts'));
    const m2 = await cx.router(new URL('http://local/cachecheck.ts'));
    const m3 = await cx.router(new URL('http://local/cachecheck.ts'));

    expect(m1).toBeDefined();
    expect(m1).not.toBe(m2);
    expect(m2).not.toBe(m3);
  });
});

describe('lazy route — patterns', () => {
  test('skips excluded files and path traversal attempts', async () => {
    const dir = makeTempDir();
    writeApi(dir, 'private/hidden.ts', 'exports.default = { type: 0, handler: () => ({}) };\n');

    const options = defineFluxionOptions({
      dir,
      host: '127.0.0.1',
      port: nextPort(),
      apiInclude: ['**/*.ts'],
      exclude: ['private/**'],
      logger: () => {},
    });
    const cx = { options } as FluxionContext;
    cx.logger = createLogger(cx);
    cx.router = createRouter(cx);

    expect(await cx.router(new URL('http://local/private/hidden.ts'))).toBeUndefined();
    expect(await cx.router(new URL('http://local/../outside.ts'))).toBeUndefined();
  });
});

describe('lazy route — disposer', () => {
  test('runs disposer after the response is sent', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    (globalThis as any).__lazy_disposed = false;
    writeApi(
      dir,
      'disposable.ts',
      `exports.default = { type: 0,
        handler: () => ({ status: 'alive' }),
        disposer: () => { (globalThis as any).__lazy_disposed = true; },
      };\n`,
    );
    await startWorkerServer(cx);

    expect((globalThis as any).__lazy_disposed).toBe(false);
    expect(await requestJson(`http://127.0.0.1:${cx.options.port}/disposable.ts`)).toEqual({
      status: 200,
      body: { status: 'alive' },
    });

    // `close` fires after the response has been flushed
    await new Promise((r) => setTimeout(r, 50));
    expect((globalThis as any).__lazy_disposed).toBe(true);
  });

  test('runs the disposer of every request instance', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    (globalThis as any).__lazy_dispose_count = 0;
    writeApi(
      dir,
      'replace.ts',
      `exports.default = { type: 0,
        handler: () => ({ version: 'a' }),
        disposer: () => { (globalThis as any).__lazy_dispose_count++; },
      };\n`,
    );
    await startWorkerServer(cx);

    expect(await requestJson(`http://127.0.0.1:${cx.options.port}/replace.ts`)).toEqual({
      status: 200,
      body: { version: 'a' },
    });
    expect(await requestJson(`http://127.0.0.1:${cx.options.port}/replace.ts`)).toEqual({
      status: 200,
      body: { version: 'a' },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect((globalThis as any).__lazy_dispose_count).toBe(2);
  });

  test('does not require a disposer', async () => {
    const dir = makeTempDir();
    const cx = makeContext(dir);

    writeApi(dir, 'plain.ts', 'exports.default = { type: 0, handler: () => ({ ok: true }) };\n');
    await startWorkerServer(cx);

    expect(await requestJson(`http://127.0.0.1:${cx.options.port}/plain.ts`)).toEqual({
      status: 200,
      body: { ok: true },
    });
  });
});
