import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { FluxionController } from '@/types.js';
import { startApp } from './helpers.js';

/** 每个用例结束都停掉实例，避免句柄泄漏拖住测试进程。 */
const controllers: FluxionController[] = [];
const track = (app: FluxionController): FluxionController => {
  controllers.push(app);
  return app;
};
afterEach(() => {
  for (const app of controllers.splice(0)) {
    app.stop();
  }
});

const get = (url: string) => fetch(url);

describe('fluxion() 返回的控制器', () => {
  it('返回值只有 stop 一个方法', async () => {
    const { app } = await startApp({ 'a.ts': 'export default 1;\n' });
    track(app);
    expect(typeof app.stop).toBe('function');
    expect(Object.keys(app)).toEqual(['stop']);
  });

  it('不依赖已规范化选项：每次调用独立归一化', async () => {
    // 两个实例各自持有缓存与端口，互不影响（对应"无模块级可变状态"）
    const first = await startApp({ 'a.ts': 'export default 1;\n' });
    const second = await startApp({ 'a.ts': 'export default 2;\n' });
    track(first.app);
    track(second.app);
    expect(first.port).not.toBe(second.port);
  });

  it('stop 后不再接受新连接', async () => {
    const { app, url } = await startApp({ 'a.ts': 'export default 1;\n' });
    expect((await get(url('/a.ts'))).status).toBe(500); // 未用 defineFluxionModule，见路由测试
    app.stop();
    await expect(get(url('/a.ts'))).rejects.toThrow();
  });

  it('stop 可重复调用', async () => {
    const { app } = await startApp({ 'a.ts': 'export default 1;\n' });
    expect(() => {
      app.stop();
      app.stop();
    }).not.toThrow();
  });

  it('stop 会强制中断在途请求', async () => {
    const { app, url } = await startApp({
      'slow.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        'export default defineFluxionModule(() => new Promise((r) => setTimeout(() => r({ done: true }), 30_000)));',
        '',
      ].join('\n'),
    });
    track(app);

    const pending = get(url('/slow.ts')).catch((e: unknown) => e);
    // 让请求真正开始
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    app.stop();

    const result = await pending;
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('HTTP 基础行为', () => {
  it('返回 JSON 并带安全头', async () => {
    const { app, url } = await startApp({
      'ok.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        "export default defineFluxionModule(() => ({ hello: 'vio' }));",
        '',
      ].join('\n'),
    });
    track(app);

    const res = await get(url('/ok.ts'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(await res.json()).toEqual({ hello: 'vio' });
  });

  it('静态资源按扩展名给 Content-Type', async () => {
    const { app, url } = await startApp({ 'index.html': '<h1>hi</h1>' });
    track(app);

    const res = await get(url('/index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>hi</h1>');
  });

  it('静态资源拒绝非 GET/HEAD', async () => {
    const { app, url } = await startApp({ 'index.html': 'x' });
    track(app);
    const res = await fetch(url('/index.html'), { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('文件不存在返回 404', async () => {
    const { app, url } = await startApp({ 'a.ts': 'export default 1;\n' });
    track(app);
    expect((await get(url('/nope.ts'))).status).toBe(404);
  });

  it('自定义 HTTP 异常按 errno 响应', async () => {
    // 这里的 shim 是非抽象类、无标记，模拟不了真实构建；真实跨构建行为见 controller.e2e.test.ts。
    // 本用例只锁定"带 errno 的异常走异常分支"这条协议。
    const { app, url } = await startApp({
      'missing.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        'class Custom extends Error { constructor(m) { super(m); this.errno = 418; this.fluxionHttpException = true; } }',
        "export default defineFluxionModule(() => { throw new Custom('teapot'); });",
        '',
      ].join('\n'),
    });
    track(app);

    const res = await get(url('/missing.ts'));
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ message: 'teapot' });
  });

  it('普通异常返回通用 500，不泄漏内部信息', async () => {
    const { app, url } = await startApp({
      'boom.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        "export default defineFluxionModule(() => { throw new Error('secret detail'); });",
        '',
      ].join('\n'),
    });
    track(app);

    const res = await get(url('/boom.ts'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('Internal Server Error');
    expect(text).not.toContain('secret detail');
  });

  it('handler 超时返回 500', async () => {
    const { app, url } = await startApp({
      'timeout.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        'export default defineFluxionModule({',
        '  handlerTimeoutMs: 150,',
        '  handler: () => new Promise((r) => setTimeout(() => r({ late: true }), 5000)),',
        '});',
        '',
      ].join('\n'),
    });
    track(app);

    const res = await get(url('/timeout.ts'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'Handler timed out' });
  });

  it('methods 限制生效', async () => {
    const { app, url } = await startApp({
      'only-get.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        "export default defineFluxionModule({ methods: ['GET'], handler: () => ({ ok: true }) });",
        '',
      ].join('\n'),
    });
    track(app);

    expect((await get(url('/only-get.ts'))).status).toBe(200);
    expect((await fetch(url('/only-get.ts'), { method: 'POST' })).status).toBe(405);
  });

  it('修改文件后下一次请求即生效（热重载）', async () => {
    const { app, dir, url } = await startApp({
      'hello.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        "export default defineFluxionModule(() => ({ v: 'one' }));",
        '',
      ].join('\n'),
    });
    track(app);

    expect(await (await get(url('/hello.ts'))).json()).toEqual({ v: 'one' });

    writeFileSync(
      join(dir, 'hello.ts'),
      [
        "import { defineFluxionModule } from 'fluxion-vio';",
        "export default defineFluxionModule(() => ({ v: 'two-longer' }));",
        '',
      ].join('\n'),
    );

    expect(await (await get(url('/hello.ts'))).json()).toEqual({ v: 'two-longer' });
  });

  it('删除文件后返回 404', async () => {
    const { app, dir, url } = await startApp({
      'gone.ts': [
        "import { defineFluxionModule } from 'fluxion-vio';",
        'export default defineFluxionModule(() => 1);',
        '',
      ].join('\n'),
    });
    track(app);

    expect((await get(url('/gone.ts'))).status).toBe(200);
    rmSync(join(dir, 'gone.ts'));
    expect((await get(url('/gone.ts'))).status).toBe(404);
  });
});
