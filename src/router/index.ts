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
 * Resolve a request URL to the module that should handle it.
 * Nothing is registered: the file is looked up on every call. API modules are reloaded only when the file or one
 * of the files it imports has changed (mtime or size).
 */
export type FluxionRouter = (url: URL) => Promise<NormalizedModule | undefined>;

export type RouterContext = Pick<FluxionContext, 'options' | 'logger' | 'moduleCache'>;

/**
 * Load an API file and attach its metadata. A file that exists but does not export a module is a server-side
 * mistake, so it throws instead of pretending the route is missing.
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

    // ! Fail if the resolved path escapes the configured directory
    const withinDir = path.relative(cx.options.dir, absolutePath);
    if (withinDir.startsWith('..') || path.isAbsolute(withinDir)) {
      return undefined;
    }

    // Excluded files are never served
    if (cx.options.exclude.some((p) => path.matchesGlob(relativePath, p))) {
      return undefined;
    }

    // The file must exist and be a regular file
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
