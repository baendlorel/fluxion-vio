import type { FluxionContext, NormalizedModule } from '../types.js';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { ModuleType, STATIC_CONTENT_TYPES, flags } from '@/common/consts.js';
import { loadFluxionModule } from '@/common/injector.js';
import type { LoadedModuleCache } from '@/common/loader.js';

/**
 * Resolve a request URL to the module that should handle it.
 * Nothing is registered: the file is looked up on every call. API modules are reloaded only when the file or one
 * of the files it imports has changed (mtime or size).
 */
export type FluxionRouter = (url: URL) => Promise<NormalizedModule | undefined>;

export function createRouter(cx: Pick<FluxionContext, 'options' | 'logger'>): FluxionRouter {
  const cache: LoadedModuleCache = new Map();

  return async (url) => {
    const relativePath = url.pathname.replace(/^[/]+/, '').replace(/[/]+$/, '');
    const absolutePath = path.join(cx.options.dir, relativePath);

    // ! Fail if the resolved path escapes the configured directory
    const withinDir = path.relative(cx.options.dir, absolutePath);
    if (withinDir.startsWith('..') || path.isAbsolute(withinDir)) {
      return undefined;
    }

    // Excluded files are never served
    if (cx.options.exclude.some((p) => minimatch(relativePath, p))) {
      return undefined;
    }

    // The file must exist and be a regular file
    const stat = await fs.stat(absolutePath).catch(() => undefined);
    if (!stat || !stat.isFile()) {
      return undefined;
    }

    if (cx.options.apiInclude.some((p) => minimatch(relativePath, p))) {
      return loadFluxionModule(cx, absolutePath, stat, cache);
    }

    if (cx.options.staticInclude.some((p) => minimatch(relativePath, p))) {
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
        cx.logger.error({ action: 'StaticResourceError', url: normalized.url, error: stat.message });
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
