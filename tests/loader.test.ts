import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { requireModule, type ModuleCache } from '@/common/loader.js';
import { defineFluxionOptions } from '@/defines/options.js';
import { installDefineShim, makeTempDir, writeFiles } from './helpers.js';

/** 加载器只需要 dir 与 target（LoaderOptions 是选项的子集）。 */
const loaderOptions = (dir: string) => {
  const { dir: normalizedDir, target } = defineFluxionOptions({ dir, host: '127.0.0.1', port: 3000 });
  return { dir: normalizedDir, target };
};

describe('模块加载器（显式传入缓存）', () => {
  it('返回 exports，default 导出可通过 result.default 取得', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'a.ts': 'export default { value: 1 };\n' });
    const exports = requireModule(new Map(), loaderOptions(dir), join(dir, 'a.ts'));
    expect(exports.default).toEqual({ value: 1 });
  });

  it('不同缓存实例互不可见（无模块级单例）', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'a.ts': 'export const value = Math.random();\n' });

    const cacheA: ModuleCache = new Map();
    const cacheB: ModuleCache = new Map();
    const options = loaderOptions(dir);

    const a1 = requireModule(cacheA, options, join(dir, 'a.ts'));
    const a2 = requireModule(cacheA, options, join(dir, 'a.ts'));
    const b1 = requireModule(cacheB, options, join(dir, 'a.ts'));

    // 同一缓存命中，返回同一实例
    expect(a2).toBe(a1);
    // 另一份缓存是全新加载，得到不同实例
    expect(b1).not.toBe(a1);
    expect(cacheA.size).toBe(1);
    expect(cacheB.size).toBe(1);
  });

  it('依赖文件修改后重新加载整条链', async () => {
    const dir = makeTempDir();
    writeFiles(dir, {
      'a.ts': "import { v } from './lib.js';\nexport default v;\n",
      'lib.ts': "export const v = 'one';\n",
    });

    const cache: ModuleCache = new Map();
    const options = loaderOptions(dir);
    expect(requireModule(cache, options, join(dir, 'a.ts')).default).toBe('one');

    // mtime 精度可能不足，改内容同时改文件大小，确保判定为变更
    writeFileSync(join(dir, 'lib.ts'), "export const v = 'two-longer';\n");
    expect(requireModule(cache, options, join(dir, 'a.ts')).default).toBe('two-longer');
  });

  it('未变更时复用缓存，不重新求值', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'a.ts': 'export const value = Math.random();\n' });
    const cache: ModuleCache = new Map();
    const options = loaderOptions(dir);
    const first = requireModule(cache, options, join(dir, 'a.ts'));
    const second = requireModule(cache, options, join(dir, 'a.ts'));
    expect(second.value).toBe(first.value);
  });

  it('文件删除后再次加载抛错', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'a.ts': 'export default 1;\n' });
    const cache: ModuleCache = new Map();
    const options = loaderOptions(dir);
    expect(requireModule(cache, options, join(dir, 'a.ts')).default).toBe(1);

    rmSync(join(dir, 'a.ts'));
    expect(() => requireModule(cache, options, join(dir, 'a.ts'))).toThrow();
  });

  it('支持 .json', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'data.json': '{"a":1}' });
    expect(requireModule(new Map(), loaderOptions(dir), join(dir, 'data.json'))).toEqual({ a: 1 });
  });

  it('支持 import.meta.url / dirname 等 define 注入', () => {
    const dir = makeTempDir();
    writeFiles(dir, {
      'meta.ts': 'export const here = import.meta.filename;\n',
    });
    const { here } = requireModule(new Map(), loaderOptions(dir), join(dir, 'meta.ts'));
    expect(here).toBe(join(dir, 'meta.ts'));
  });

  it('顶层声明 __dirname 的文件仍能加载', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'shadow.ts': 'const __dirname = "local";\nexport default __dirname;\n' });
    const exports = requireModule(new Map(), loaderOptions(dir), join(dir, 'shadow.ts'));
    expect(exports.default).toBe('local');
  });

  it('node_modules 外的依赖走原生 require，不进入热缓存', () => {
    const dir = makeTempDir();
    installDefineShim(dir);
    writeFiles(dir, {
      'a.ts': "import { defineFluxionModule } from 'fluxion-vio';\nexport default defineFluxionModule(() => 1);\n",
    });
    const cache: ModuleCache = new Map();
    const exports = requireModule(cache, loaderOptions(dir), join(dir, 'a.ts'));
    expect(exports.default.type).toBe(0);
    // 缓存里只应有 a.ts 自己，fluxion-vio 走了原生 require
    expect(cache.size).toBe(1);
  });
});
