import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { startServer } from './e2e-helpers.js';

const define = (body: string) =>
  [
    "import { defineFluxionModule } from 'fluxion-vio';",
    `export default defineFluxionModule(${body});`,
    '',
  ].join('\n');

describe('控制器（dist 构建，真实 ESM 入口）', () => {
  it('fluxion() 返回的控制器只有 stop', async () => {
    const server = await startServer({ 'a.ts': define('() => 1') });
    try {
      // 控制器形态由 src 单测覆盖；这里确认实例可正常启停
      expect((await fetch(server.url('/a.ts'))).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('stop 后连接被拒绝', async () => {
    const server = await startServer({ 'a.ts': define('() => 1') });
    expect((await fetch(server.url('/a.ts'))).status).toBe(200);
    await server.stop();
    await expect(fetch(server.url('/a.ts'))).rejects.toThrow();
  });

  it('stop 强制中断在途请求', async () => {
    const server = await startServer({
      'slow.ts': define('() => new Promise((r) => setTimeout(() => r({ done: true }), 30_000))'),
    });

    const pending = fetch(server.url('/slow.ts')).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    await server.stop();

    expect(await pending).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('HTTP 基础行为（dist 构建）', () => {
  it('返回 JSON 并带安全头', async () => {
    const server = await startServer({ 'ok.ts': define("() => ({ hello: 'vio' })") });
    try {
      const res = await fetch(server.url('/ok.ts'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
      expect(await res.json()).toEqual({ hello: 'vio' });
    } finally {
      await server.stop();
    }
  });

  it('静态资源按扩展名给 Content-Type，并拒绝非 GET/HEAD', async () => {
    const server = await startServer({ 'index.html': '<h1>hi</h1>' });
    try {
      const res = await fetch(server.url('/index.html'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('<h1>hi</h1>');

      const denied = await fetch(server.url('/index.html'), { method: 'POST' });
      expect(denied.status).toBe(405);
      expect(denied.headers.get('allow')).toBe('GET, HEAD');
    } finally {
      await server.stop();
    }
  });

  it('文件不存在返回 404', async () => {
    const server = await startServer({ 'a.ts': define('() => 1') });
    try {
      expect((await fetch(server.url('/nope.ts'))).status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('抛 HttpException 时按状态码响应（跨 ESM/CJS 构建）', async () => {
    const server = await startServer({
      'missing.ts': [
        "import { defineFluxionModule, NotFoundException } from 'fluxion-vio';",
        "export default defineFluxionModule(() => { throw new NotFoundException('no such thing'); });",
        '',
      ].join('\n'),
    });
    try {
      const res = await fetch(server.url('/missing.ts'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'no such thing' });
    } finally {
      await server.stop();
    }
  });

  it('普通异常返回通用 500，不泄漏内部信息', async () => {
    const server = await startServer({
      'boom.ts': define("() => { throw new Error('secret detail'); }"),
    });
    try {
      const res = await fetch(server.url('/boom.ts'));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain('Internal Server Error');
      expect(text).not.toContain('secret detail');
    } finally {
      await server.stop();
    }
  });

  it('handler 超时返回 500', async () => {
    const server = await startServer({
      'timeout.ts': define(
        '{ handlerTimeoutMs: 150, handler: () => new Promise((r) => setTimeout(() => r({ late: true }), 5000)) }',
      ),
    });
    try {
      const res = await fetch(server.url('/timeout.ts'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'Handler timed out' });
    } finally {
      await server.stop();
    }
  });

  it('methods 限制生效', async () => {
    const server = await startServer({
      'only-get.ts': define("{ methods: ['GET'], handler: () => ({ ok: true }) }"),
    });
    try {
      expect((await fetch(server.url('/only-get.ts'))).status).toBe(200);
      expect((await fetch(server.url('/only-get.ts'), { method: 'POST' })).status).toBe(405);
    } finally {
      await server.stop();
    }
  });

  it('修改文件后下一次请求即生效', async () => {
    const server = await startServer({ 'hello.ts': define("() => ({ v: 'one' })") });
    try {
      expect(await (await fetch(server.url('/hello.ts'))).json()).toEqual({ v: 'one' });
      writeFileSync(join(server.dir, 'hello.ts'), define("() => ({ v: 'two-longer' })"));
      expect(await (await fetch(server.url('/hello.ts'))).json()).toEqual({ v: 'two-longer' });
    } finally {
      await server.stop();
    }
  });

  it('删除文件后返回 404', async () => {
    const server = await startServer({ 'gone.ts': define('() => 1') });
    try {
      expect((await fetch(server.url('/gone.ts'))).status).toBe(200);
      rmSync(join(server.dir, 'gone.ts'));
      expect((await fetch(server.url('/gone.ts'))).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
