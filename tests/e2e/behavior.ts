/**
 * End-to-end behaviour test: a real `fluxion()` server, a real directory on disk, and a real edit.
 *
 * Layout: a.ts -> b.ts -> c.ts
 *   1. request /a.ts and check the value produced through the chain
 *   2. rewrite b.ts on disk
 *   3. request /a.ts again and check the new value is served
 *
 * This file is not picked up by `vitest` (its include patterns need `*.test.ts` / `*.e2e-spec.ts`),
 * so run it directly:
 *
 *   pnpm tsx tests/e2e/behavior.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fluxion } from '../../src/index.js';

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

const getJson = async (url: string) => {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxion-e2e-'));
const file = (name: string) => path.join(dir, name);
const write = (name: string, body: string) => fs.writeFileSync(file(name), body);

const serverSource = (version: string) =>
  `import { c } from './c';\nexport const b = 'b-${version}+' + c;\n`;

try {
  // c is the leaf, b builds on it, a is the API handler the client asks for.
  // c counts its own evaluations, so a stale-looking value proves whether it was reloaded.
  write(
    'c.ts',
    `const g = globalThis as any;
g.__e2e = g.__e2e ?? { c: 0 };
g.__e2e.c += 1;
export const c = 'c-v1#' + g.__e2e.c;
`,
  );
  write('b.ts', serverSource('v1'));
  write('a.ts', `import { b } from './b';\nexport default { type: 0, handler: () => ({ value: b }) };\n`);

  // Basic options only: where the routes live, where to listen
  const port = await freePort();
  await fluxion({ dir, host: '127.0.0.1', port });
  const url = `http://127.0.0.1:${port}/a.ts`;

  const first = await getJson(url);
  assert.equal(first.value, 'b-v1+c-v1#1', 'the chain a -> b -> c should be evaluated on the first request');
  console.log('ok: first request served the original chain');

  // Change nothing but b, keeping the same byte length so detection relies on mtime alone
  const before = fs.statSync(file('b.ts')).mtimeMs;
  write('b.ts', serverSource('v2'));
  const after = fs.statSync(file('b.ts')).mtimeMs;
  assert.notEqual(after, before, 'the edit should change b.ts mtime');

  const second = await getJson(url);
  // * Every file in the chain is dropped when one of them changes, so c is evaluated a second time;
  // * its value is unchanged because only b was edited.
  assert.equal(second.value, 'b-v2+c-v1#2', 'a should pick up the edited b, reloading the whole chain');
  console.log('ok: editing b.ts reloaded the a -> b -> c chain and served the new b');

  // Nothing changed since the last request, so the cached instances are reused
  const third = await getJson(url);
  assert.equal(third.value, 'b-v2+c-v1#2', 'an unchanged request should reuse the loaded chain');
  console.log('ok: the following request reused the reloaded chain');

  console.log('PASS: a.ts -> b.ts -> c.ts reloads when b.ts changes');
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The server created by fluxion() keeps the event loop alive; the test is over.
process.exit(process.exitCode ?? 0);
