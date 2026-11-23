import type { FluxionContext, NormalizedModule } from '../types.js';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';

import { ModuleType, STATIC_CONTENT_TYPES, flags } from '../common/consts.js';
import { FluxionError } from '../common/error.js';
import { normalizeModule, selectModule } from '../common/injector.js';
import { requireModule } from '../common/loader.js';

/**
 * 把请求 URL 解析成处理它的模块。
 * 不做任何注册：每次调用都直接查文件。API 模块只在自身或它 import 的文件变更（mtime 或 size）时重新加载。
 */
export type FluxionRouter = (url: URL) => Promise<NormalizedModule | undefined>;

export type RouterContext = Pick<FluxionContext, 'options' | 'logger' | 'moduleCache'>;

/**
 * 加载 API 文件并附上元信息。文件存在但没导出模块属于服务端错误，所以抛出异常而不是伪装成路由不存在。
 */
const loadModule = (cx: RouterContext, absolutePath: string, stat: Stats): NormalizedModule => {
  const exports = requireModule(cx.moduleCache, cx.options, absolutePath);
  const { module, rejection } = selectModule(exports);
  if (module === undefined) {
    cx.logger.error({ event: 'InvalidModule', url: absolutePath, error: rejection });
    throw new FluxionError(
      `Invalid handler module '${absolutePath}', make sure it satisfies defineFluxionModule(...) helper`,
    );
  }
  return normalizeModule(module, absolutePath, stat);
};

export function createRouter(cx: RouterContext): FluxionRouter {
  return async (url) => {
    const relativePath = url.pathname.replace(/^[/]+/, '').replace(/[/]+$/, '');
    const absolutePath = path.join(cx.options.dir, relativePath);

    // ! 解析后的路径逃出配置目录时直接拒绝
    const withinDir = path.relative(cx.options.dir, absolutePath);
    if (withinDir.startsWith('..') || path.isAbsolute(withinDir)) {
      return undefined;
    }

    // 命中 exclude 的文件永远不提供
    if (cx.options.exclude.some((p) => path.matchesGlob(relativePath, p))) {
      return undefined;
    }

    // 必须是存在的普通文件
    const stat = await fs.stat(absolutePath).catch(() => undefined);
    if (!stat || !stat.isFile()) {
      return undefined;
    }

    if (cx.options.apiInclude.some((p) => path.matchesGlob(relativePath, p))) {
      return loadModule(cx, absolutePath, stat);
    }

    if (cx.options.staticInclude.some((p) => path.matchesGlob(relativePath, p))) {
      return makeStaticResource(absolutePath);
    }

    return undefined;
  };
}

function makeStaticResource(absolutePath: string): NormalizedModule {
  return {
    type: ModuleType.StaticResource,
    mtimeMs: NaN,
    absolutePath,
    handler: async (normalized, cx, req, res) => {
      if (normalized.method !== 'GET' && normalized.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end();
        return;
      }

      const stat = await fs.stat(absolutePath).catch((e: Error) => e);
      if (stat instanceof Error) {
        res.statusCode = 404;
        res.end('Not Accessible');
        cx.logger.error({
          event: 'StaticResourceError',
          url: normalized.url.pathname,
          error: stat.message,
        });
        return null;
      }

      if (!stat.isFile()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const extension = path.extname(absolutePath).toLowerCase();
      const contentType = STATIC_CONTENT_TYPES[extension] ?? 'application/octet-stream';

      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(stat.size));

      if (normalized.method === 'HEAD') {
        res.end();
        return;
      }

      return new Promise<symbol>((resolve, reject) => {
        const stream = createReadStream(absolutePath);

        const cleanup = () => {
          stream.off('error', onError);
          stream.off('end', onEnd);
          res.off('close', onClientClose);
          req.off('aborted', onClientClose);
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const onEnd = () => {
          cleanup();
          resolve(flags.StaticHandled);
        };

        const onClientClose = () => {
          cleanup();
          stream.destroy();
          resolve(flags.StaticHandled);
        };

        stream.on('error', onError);
        stream.on('end', onEnd);
        res.on('close', onClientClose);
        req.on('aborted', onClientClose);

        stream.pipe(res);
      });
    },
  };
}
