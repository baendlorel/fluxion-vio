import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ModuleType } from '@/common/consts.js';
import { installDefineShim, makeRouterContext, makeTempDir, writeFiles } from './helpers.js';

const MODULE_SOURCE = `import { defineFluxionModule } from 'fluxion-vio';
export default defineFluxionModule(() => ({ ok: true }));
`;

/** 直接调用 router，不经过 HTTP。 */
const resolve = (router: ReturnType<typeof makeRouterContext>['router'], pathname: string) =>
  router(new URL(pathname, 'http://fluxion.local'));

describe('路由解析（纯查表，无注册表）', () => {
  it('命中 apiInclude 的文件解析为 API 模块', async () => {
    const dir = makeTempDir();
    installDefineShim(dir);
    writeFiles(dir, { 'hello.ts': MODULE_SOURCE });
    const { router } = makeRouterContext(dir);

    const m = await resolve(router, '/hello.ts');
    expect(m?.type).toBe(ModuleType.Api);
    expect(m?.absolutePath).toBe(join(dir, 'hello.ts'));
    expect(typeof m?.handler).toBe('function');
  });

  it('命中 staticInclude 的文件解析为静态资源', async () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'index.html': '<h1>hi</h1>' });
    const { router } = makeRouterContext(dir);

    const m = await resolve(router, '/index.html');
    expect(m?.type).toBe(ModuleType.Static);
  });

  it('嵌套路径与扩展名都是路由的一部分', async () => {
    const dir = makeTempDir();
    installDefineShim(dir);
    writeFiles(dir, { 'user/profile.ts': MODULE_SOURCE });
    const { router } = makeRouterContext(dir);

    expect((await resolve(router, '/user/profile.ts'))?.type).toBe(ModuleType.Api);
    expect(await resolve(router, '/user/profile')).toBeUndefined();
  });

  it('不存在的文件返回 undefined', async () => {
    const { router } = makeRouterContext(makeTempDir());
    expect(await resolve(router, '/missing.ts')).toBeUndefined();
  });

  it('目录解析为 undefined', async () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'sub/a.txt': 'x' });
    const { router } = makeRouterContext(dir);
    expect(await resolve(router, '/sub')).toBeUndefined();
  });

  it('命中 exclude 的文件不被提供', async () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'secret/x.ts': MODULE_SOURCE, 'public.ts': MODULE_SOURCE });
    installDefineShim(dir);
    const { router } = makeRouterContext(dir, { exclude: ['**/secret/**'] });

    expect(await resolve(router, '/secret/x.ts')).toBeUndefined();
    expect((await resolve(router, '/public.ts'))?.type).toBe(ModuleType.Api);
  });

  it('路径穿越被拒绝', async () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'a.ts': MODULE_SOURCE });
    const { router } = makeRouterContext(dir);

    // URL 会在解析阶段折叠 ..，所以这里构造一个仍能表达的穿越形态
    expect(await resolve(router, '/../outside.ts')).toBeUndefined();
    expect(await resolve(router, '/%2e%2e/outside.ts')).toBeUndefined();
  });

  it('API 文件没有导出模块时抛错并记录 InvalidModule', async () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'bad.ts': 'export default () => ({ ok: true });\n' });
    const { router, entries } = makeRouterContext(dir);

    await expect(resolve(router, '/bad.ts')).rejects.toThrow(/defineFluxionModule/);
    expect(entries.some((e) => e.event === 'InvalidModule')).toBe(true);
  });

  it('两次解析同一文件返回同一实例（缓存命中）', async () => {
    const dir = makeTempDir();
    installDefineShim(dir);
    writeFiles(dir, { 'hello.ts': MODULE_SOURCE });
    const { router } = makeRouterContext(dir);

    const first = await resolve(router, '/hello.ts');
    const second = await resolve(router, '/hello.ts');
    expect(second).toBe(first);
  });

  it('依赖文件变化后解析出新实例', async () => {
    const dir = makeTempDir();
    installDefineShim(dir);
    writeFiles(dir, {
      'hello.ts': "import { label } from './lib.js';\nimport { defineFluxionModule } from 'fluxion-vio';\nexport default defineFluxionModule(() => label);\n",
      'lib.ts': "export const label = 'one';\n",
    });
    const { router } = makeRouterContext(dir);

    const first = await resolve(router, '/hello.ts');
    expect(first).toBeDefined();

    writeFileSync(join(dir, 'lib.ts'), "export const label = 'two-longer';\n");
    const second = await resolve(router, '/hello.ts');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});
