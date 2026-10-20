import { FluxionError } from './error.js';
import type { FluxionContext, NormalizedModule } from '@/types.js';
import { realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { static_cast } from 'type-narrow';
import { ModuleType } from './consts.js';

function isFluxionModule(cx: Pick<FluxionContext, 'options' | 'logger'>, o: unknown): o is NormalizedModule {
  if (typeof o !== 'object' || o === null) {
    return false;
  }

  static_cast<NormalizedModule>(o);

  if (typeof o.handler !== 'function') {
    cx.logger.error(`handler must be a function`);
    return false;
  }

  if (o.disposer !== undefined && typeof o.disposer !== 'function') {
    cx.logger.error(`disposer must be a function if provided`);
    return false;
  }

  const ms = o.handlerTimeoutMs;
  if (ms !== undefined && (!Number.isSafeInteger(ms) || ms < 100)) {
    cx.logger.error(`handlerTimeoutMs must be an integer >= 100 if provided`);
    return false;
  }

  if (o.type !== ModuleType.Api) {
    cx.logger.error(`You must use defineFluxionModule to create module`);
    return false;
  }

  return true;
}

/**
 * Build the prefix used to match `require.cache` keys against `dir`.
 *
 * `require.cache` keys are real paths, while `options.dir` comes from `path.resolve`.
 * Resolving `dir` through symlinks once, at router creation, keeps the per-request check
 * a plain string comparison and still matches files reached through a symlinked directory.
 */
export function createCacheRoot(dir: string): string {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    // `dir` is created during option normalization, so this only guards against races.
    root = path.resolve(dir);
  }
  return root.endsWith(path.sep) ? root : root + path.sep;
}

/**
 * Drop every cached module under `root`, so the next require re-reads it from disk.
 *
 * Only files inside the dynamic directory are purged: they are the ones the user edits.
 * Anything a handler pulls from `node_modules` (and other paths outside `dir`) stays cached,
 * because dependency code is not hot-reloaded and re-evaluating it per request is very costly.
 */
export function purgeRequireCache(root: string): void {
  const cache = require.cache;
  for (const id of Object.keys(cache)) {
    if (id.startsWith(root)) {
      delete cache[id];
    }
  }
}

export function loadFluxionModule(
  cx: Pick<FluxionContext, 'options' | 'logger'>,
  absolutePath: string,
  stat: Stats,
): NormalizedModule {
  let m = require(absolutePath);
  if (isFluxionModule(cx, m.default)) {
    m = m.default;
  } else if (isFluxionModule(cx, m)) {
  } else {
    throw new FluxionError(
      `Invalid handler module '${absolutePath}', make sure it satisfies defineFluxionModule(...) helper`,
    );
  }

  m.absolutePath = absolutePath;
  m.mtimeMs = stat.mtimeMs;

  return m;
}
