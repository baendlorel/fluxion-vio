import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import type { FluxionContext, FluxionOptions, NormalizedFluxionOptions } from '@/types.js';
import type { LogEntry } from '@/common/logger.js';
import { createLogger } from '@/common/logger.js';
import { defineFluxionOptions } from '@/defines/options.js';
import { createRouter } from '@/router/index.js';
import { fluxion } from '@/fluxion.js';

/** 创建一个临时目录，用来放动态文件。 */
export const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'fluxion-vio-test-'));

/** 按 `{ 相对路径: 内容 }` 写入文件，父目录自动创建。 */
export const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
};

/** `dir` 始终以分隔符结尾，和 NormalizedFluxionOptions 的约定一致。 */
export const withTrailingSep = (dir: string): string => (dir.endsWith(sep) ? dir : dir + sep);

/** 用自定义 sink 构造 logger，同时拿到它写出的所有条目。 */
export const createLogSpy = (): { entries: LogEntry[]; logger: ReturnType<typeof createLogger> } => {
  const entries: LogEntry[] = [];
  const sink = (entry: LogEntry): void => {
    entries.push(entry);
  };
  const logger = createLogger({ options: { logger: sink } } as unknown as Pick<FluxionContext, 'options'>);
  return { entries, logger };
};

/** 构造规范化选项；默认关掉日志输出，避免测试刷屏。 */
export const makeOptions = (
  dir: string,
  extra: Partial<FluxionOptions> = {},
): NormalizedFluxionOptions =>
  defineFluxionOptions({ dir, host: '127.0.0.1', port: 3000, logger: () => {}, ...extra });

/** 一个可用路由的全部依赖（函数式：缓存与依赖都显式传入）。 */
export const makeRouterContext = (dir: string, extra: Partial<FluxionOptions> = {}) => {
  const options = makeOptions(dir, extra);
  const { entries, logger } = createLogSpy();
  const moduleCache = new Map();
  return { options, entries, logger, moduleCache, router: createRouter({ options, logger, moduleCache }) };
};

/**
 * 在临时目录里伪造 node_modules/fluxion-vio，让动态文件可以真实地 `import { defineFluxionModule }`。
 * 只是 `defineFluxionModule` 的最小等价物：补上 type: 0（ModuleType.Api）。
 */
export const installDefineShim = (dir: string): void => {
  writeFiles(dir, {
    'node_modules/fluxion-vio/package.json': JSON.stringify({
      name: 'fluxion-vio',
      version: '0.0.0-test',
      main: 'index.cjs',
    }),
    'node_modules/fluxion-vio/index.cjs': [
      'exports.defineFluxionModule = (a) =>',
      "  typeof a === 'function' ? { handler: a, type: 0 } : { ...a, type: 0 };",
      // 与真实构建一致：用 Symbol.for 标记，isHttpException 靠它识别（跨 ESM/CJS 都是同一个 symbol）。
      "const MARK = Symbol.for('FLUXION_HTTP_EXCEPTION');",
      'class HttpException extends Error {',
      '  constructor(message, errno, code) {',
      '    super(message);',
      '    this.errno = errno;',
      '    this.code = code;',
      '    this[MARK] = true;',
      '  }',
      '}',
      "class NotFoundException extends HttpException { constructor(m = 'Not Found') { super(m, 404, 'NOT_FOUND'); } }",
      'exports.HttpException = HttpException;',
      'exports.NotFoundException = NotFoundException;',
      '',
    ].join('\n'),
  });
};

/** 向系统要一个空闲端口，避免测试之间互相抢占。 */
export const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** 起一个完整的 fluxion 实例（含临时目录、shim 与闭包静音 logger）。 */
export const startApp = async (
  files: Record<string, string>,
  extra: Partial<FluxionOptions> = {},
): Promise<{
  app: Awaited<ReturnType<typeof fluxion>>;
  dir: string;
  port: number;
  url: (path: string) => string;
}> => {
  const dir = makeTempDir();
  installDefineShim(dir);
  writeFiles(dir, files);
  const port = await getFreePort();
  const app = await fluxion({ dir, host: '127.0.0.1', port, logger: () => {}, ...extra });
  return { app, dir, port, url: (path: string) => `http://127.0.0.1:${port}${path}` };
};
