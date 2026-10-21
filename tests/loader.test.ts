import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fluxionRequire, moduleCache as cache } from '../src/common/loader.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxion-loader-test-'));
const g = globalThis as any;

const write = (rel: string, content: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const count = (key: string) => `globalThis.__cnt.${key} = (globalThis.__cnt.${key} ?? 0) + 1;`;

// Two writes within a few ms can end up with the same mtime, so the tests pin it themselves
const T0 = 1_700_000_000;
const stamp = (file: string, n: number) => fs.utimesSync(file, T0 + n, T0 + n);
const edit = (file: string, content: string, n: number) => {
  fs.writeFileSync(file, content);
  stamp(file, n);
};

// top -> mid -> leaf, and a `side` that requires nothing; every file counts its own evaluations
const makeChain = (name: string) => {
  const leafSource = (v: number) => `${count(`${name}_leaf`)} export const leafV = ${v};`;
  const files = {
    top: write(`app/${name}/top.ts`, `import { midV } from './mid'; ${count(`${name}_top`)} export const topV = midV;`),
    mid: write(
      `app/${name}/mid.ts`,
      `import { leafV } from './leaf'; ${count(`${name}_mid`)} export const midV = leafV;`,
    ),
    leaf: write(`app/${name}/leaf.ts`, leafSource(1)),
    side: write(`app/${name}/side.ts`, `${count(`${name}_side`)} export const sideV = 1;`),
  };
  Object.values(files).forEach((f) => stamp(f, 0));
  const counts = () => ['top', 'mid', 'leaf', 'side'].map((k) => g.__cnt[`${name}_${k}`] ?? 0);
  return { files, leafSource, counts };
};

// app/ is `dir`; outside/ and node_modules/ are not
write('node_modules/fakepkg/package.json', '{"name":"fakepkg","main":"index.js"}');
write('node_modules/fakepkg/index.js', `${count('pkg')} module.exports = { n: globalThis.__cnt.pkg };`);
write('outside/shared.js', `${count('outside')} module.exports = { n: globalThis.__cnt.outside };`);
write('app/lib/deep.ts', `${count('deep')} export const deepN: number = globalThis.__cnt.deep;`);
write(
  'app/lib/mid.ts',
  `import { deepN } from './deep';
${count('mid')}
export const midN: number = globalThis.__cnt.mid;
export { deepN };`,
);
write('app/cjs-dep.js', `${count('cjs')} module.exports = { n: globalThis.__cnt.cjs };`);
write('app/data.json', '{"hello":"world"}');
write(
  'app/sub/where.ts',
  'export const info = { dirname: __dirname, filename: __filename, metaDir: import.meta.dirname };',
);
write('app/lazy.ts', `${count('lazy')} export const lazyN: number = globalThis.__cnt.lazy;`);
write(
  'app/entry.ts',
  `import { midN, deepN } from './lib/mid';
import fakepkg from 'fakepkg';
import shared from '../outside/shared.js';
import data from './data.json';
import { info } from './sub/where';
import { readFileSync } from 'node:fs';
const cjs = require('./cjs-dep.js');
${count('entry')}
export default {
  entry: globalThis.__cnt.entry, mid: midN, deep: deepN, fakepkg: fakepkg.n, outside: shared.n, cjs: cjs.n,
  data, info, hasFs: typeof readFileSync,
  lazy: () => import('./lazy').then((m) => m.lazyN),
  lazyDynamic: (p: string) => import(p).then((m: any) => m.lazyN),
};`,
);
// neither side reads the other's exports while loading, which would be a TDZ error in native ESM too
write('app/cycle-a.ts', `import { b } from './cycle-b'; export const a = 'a'; export const readB = () => b;`);
write('app/cycle-b.ts', `import { a } from './cycle-a'; export const b = 'b'; export const readA = () => a;`);
write('app/broken.ts', `${count('broken')} throw new Error('boom');`);
write('app/missing.ts', `import './nope';`);

const entry = path.join(root, 'app/entry.ts');
const dir = path.join(root, 'app');

beforeEach(() => {
  g.__cnt = {};
  cache.clear();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fluxionRequire scope', () => {
  test('imports under dir are loaded by the loader and re-evaluated after a reload', () => {
    fluxionRequire(entry, { dir });
    cache.clear();
    const second = fluxionRequire(entry, { dir }).default;

    expect(second).toMatchObject({ entry: 2, mid: 2, deep: 2, cjs: 2, data: { hello: 'world' }, hasFs: 'function' });
  });

  test('imports of node_modules and files outside dir stay on the native require', () => {
    fluxionRequire(entry, { dir });
    cache.clear();
    const second = fluxionRequire(entry, { dir }).default;

    expect(second.fakepkg).toBe(1);
    expect(second.outside).toBe(1);
  });

  test('a wider dir makes the files outside the entry directory hot, node_modules stays native', () => {
    fluxionRequire(entry, { dir: root });
    cache.clear();
    const second = fluxionRequire(entry, { dir: root }).default;

    expect(second.outside).toBe(2);
    expect(second.fakepkg).toBe(1);
  });

  test('each file sees its own __dirname, __filename and import.meta', () => {
    const { info } = fluxionRequire(entry, { dir }).default;

    expect(info).toEqual({
      dirname: path.join(dir, 'sub'),
      filename: path.join(dir, 'sub/where.ts'),
      metaDir: path.join(dir, 'sub'),
    });
  });

  test('dynamic import() of a local file goes through the loader, literal or not', async () => {
    const first = fluxionRequire(entry, { dir }).default;

    // both hit the one module table, so the file is evaluated once
    expect(await first.lazy()).toBe(1);
    expect(await first.lazyDynamic(path.join(dir, 'lazy.ts'))).toBe(1);
    expect(g.__cnt.lazy).toBe(1);

    // after a reload, the new instance has its own
    cache.clear();
    const second = fluxionRequire(entry, { dir }).default;
    expect(await second.lazyDynamic(path.join(dir, 'lazy.ts'))).toBe(2);
  });
});

describe('fluxionRequire cache', () => {
  test('modules are evaluated once and shared between calls', () => {
    const first = fluxionRequire(entry, { dir });
    const second = fluxionRequire(entry, { dir });

    expect(second).toBe(first);
    expect(g.__cnt).toMatchObject({ entry: 1, mid: 1, deep: 1, cjs: 1 });
  });

  test('cache is keyed by absolute path and holds every file under dir, nothing else', () => {
    fluxionRequire(entry, { dir });

    expect([...cache.keys()].sort()).toEqual(
      [
        entry,
        path.join(dir, 'lib/mid.ts'),
        path.join(dir, 'lib/deep.ts'),
        path.join(dir, 'cjs-dep.js'),
        path.join(dir, 'data.json'),
        path.join(dir, 'sub/where.ts'),
      ].sort(),
    );
  });

  test('a module records its own mtime and size and the modules it required', () => {
    const c = makeChain('record');
    fluxionRequire(c.files.top, { dir });

    const { mtimeMs, size } = fs.statSync(c.files.top);
    expect(cache.get(c.files.top)).toMatchObject({ mtimeMs, size });
    expect([...cache.get(c.files.top)!.deps.keys()]).toEqual([c.files.mid]);
    expect([...cache.get(c.files.mid)!.deps.keys()]).toEqual([c.files.leaf]);
    expect(cache.get(c.files.leaf)!.deps.size).toBe(0);
  });

  test('editing the table by hand still works: a deleted file invalidates whatever required it', () => {
    const c = makeChain('manual');
    fluxionRequire(c.files.top, { dir });
    cache.delete(c.files.leaf);
    fluxionRequire(c.files.top, { dir });
    expect(c.counts()).toEqual([2, 2, 2, 0]);

    cache.clear();
    fluxionRequire(c.files.top, { dir });
    expect(c.counts()).toEqual([3, 3, 3, 0]);
  });
});

describe('fluxionRequire mtime rules', () => {
  test('a second access with nothing changed returns the cache and evaluates nothing', () => {
    const c = makeChain('same');
    const first = fluxionRequire(c.files.top, { dir });
    const second = fluxionRequire(c.files.top, { dir });

    expect(second).toBe(first);
    expect(c.counts()).toEqual([1, 1, 1, 0]);
  });

  test('a newer mtime on the file itself reloads the whole chain', () => {
    const c = makeChain('self');
    fluxionRequire(c.files.top, { dir });
    stamp(c.files.top, 1);
    fluxionRequire(c.files.top, { dir });

    expect(c.counts()).toEqual([2, 2, 2, 0]);
  });

  test('a change in a deep dependency reloads everything related and shows the new content', () => {
    const c = makeChain('deep');
    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(1);
    fluxionRequire(c.files.side, { dir });

    edit(c.files.leaf, c.leafSource(2), 1);

    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(2);
    expect(c.counts()).toEqual([2, 2, 2, 1]);
  });

  test('a change in a file outside the chain leaves the chain alone', () => {
    const c = makeChain('unrelated');
    fluxionRequire(c.files.top, { dir });
    fluxionRequire(c.files.side, { dir });

    stamp(c.files.side, 1);
    fluxionRequire(c.files.top, { dir });
    expect(c.counts()).toEqual([1, 1, 1, 1]);

    fluxionRequire(c.files.side, { dir });
    expect(c.counts()).toEqual([1, 1, 1, 2]);
  });

  test('an older mtime counts as a change too, e.g. a file restored from a backup', () => {
    const c = makeChain('older');
    fluxionRequire(c.files.top, { dir });
    stamp(c.files.leaf, -10);
    fluxionRequire(c.files.top, { dir });

    expect(c.counts()).toEqual([2, 2, 2, 0]);
  });

  test('a different size is a change even when the mtime is the same', () => {
    const c = makeChain('size');
    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(1);

    edit(c.files.leaf, c.leafSource(22), 0);

    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(22);
    expect(c.counts()).toEqual([2, 2, 2, 0]);
  });

  test('same mtime and same size is taken as unchanged, even if the content is not', () => {
    const c = makeChain('content');
    fluxionRequire(c.files.top, { dir });
    edit(c.files.leaf, c.leafSource(2), 0);

    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(1);
    expect(c.counts()).toEqual([1, 1, 1, 0]);
  });

  test('a new file is only loaded when it is asked for, directly or through a file that changed to import it', () => {
    const c = makeChain('late');
    fluxionRequire(c.files.top, { dir });

    const late = write('app/late/late.ts', `${count('late_late')} export const lateV = 7;`);
    fluxionRequire(c.files.top, { dir });
    expect(g.__cnt.late_late).toBeUndefined();
    expect(cache.has(late)).toBe(false);

    // The only way an existing file can reach it is by being edited, which changes its mtime or size
    edit(c.files.leaf, `import { lateV } from './late'; export const leafV = lateV;`, 0);
    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(7);
    expect(g.__cnt.late_late).toBe(1);
    expect(cache.has(late)).toBe(true);
  });

  test('a dependency deleted from disk fails the reload and leaves nothing stale', () => {
    const c = makeChain('gone');
    fluxionRequire(c.files.top, { dir });

    fs.rmSync(c.files.leaf);
    expect(() => fluxionRequire(c.files.top, { dir })).toThrow(/Cannot find module/);
    expect(cache.size).toBe(0);

    edit(c.files.leaf, c.leafSource(3), 2);
    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(3);
  });

  test('a dependency that throws on reload fails the call and leaves nothing stale', () => {
    const c = makeChain('throws');
    fluxionRequire(c.files.top, { dir });

    edit(c.files.leaf, `throw new Error('boom');`, 1);
    expect(() => fluxionRequire(c.files.top, { dir })).toThrow('boom');
    expect(cache.size).toBe(0);

    edit(c.files.leaf, c.leafSource(2), 2);
    expect(fluxionRequire(c.files.top, { dir }).topV).toBe(2);
  });

  test('a module shared by two entries: reloading one makes the other follow once, onto the same instance', () => {
    const shared = write('app/shared-entries/shared.ts', `${count('sh_shared')} export const shared = {};`);
    const e1 = write('app/shared-entries/e1.ts', `export { shared } from './shared';`);
    const e2 = write('app/shared-entries/e2.ts', `export { shared } from './shared';`);
    [shared, e1, e2].forEach((f) => stamp(f, 0));

    const a = fluxionRequire(e1, { dir });
    const b = fluxionRequire(e2, { dir });
    expect(b.shared).toBe(a.shared);

    stamp(shared, 1);
    const a2 = fluxionRequire(e1, { dir });
    expect(a2.shared).not.toBe(a.shared);

    // e2 still holds the old instance, so it reloads, but `shared` is not evaluated a third time
    const b2 = fluxionRequire(e2, { dir });
    expect(b2.shared).toBe(a2.shared);
    expect(g.__cnt.sh_shared).toBe(2);
  });
});

describe('fluxionRequire edge cases', () => {
  test('circular imports resolve instead of looping', () => {
    const a = fluxionRequire(path.join(dir, 'cycle-a.ts'), { dir });
    const b = fluxionRequire(path.join(dir, 'cycle-b.ts'), { dir });

    expect(a.readB()).toBe('b');
    expect(b.readA()).toBe('a');
    // walking the chain of a cached cycle terminates and hits the cache
    expect(fluxionRequire(path.join(dir, 'cycle-a.ts'), { dir })).toBe(a);
  });

  test('a module that throws is not left in the cache', () => {
    const file = path.join(dir, 'broken.ts');

    expect(() => fluxionRequire(file, { dir })).toThrow('boom');
    expect(cache.size).toBe(0);
    expect(() => fluxionRequire(file, { dir })).toThrow('boom');
    expect(g.__cnt.broken).toBe(2);
  });

  test('an import that cannot be found surfaces the native error', () => {
    expect(() => fluxionRequire(path.join(dir, 'missing.ts'), { dir })).toThrow(/Cannot find module/);
  });

  test('edits on disk show up on the next call', () => {
    const file = write('app/editable.ts', 'export const v = 1;');
    stamp(file, 0);
    expect(fluxionRequire(file, { dir }).v).toBe(1);

    edit(file, 'export const v = 2;', 1);
    expect(fluxionRequire(file, { dir }).v).toBe(2);
  });
});
