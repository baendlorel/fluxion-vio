import type { NormalizedModule } from '@/types.js';
import type { Stats } from 'node:fs';
import { ModuleType } from './consts.js';

/** Why a value is not a usable `NormalizedModule`. */
export type ModuleRejection =
  | 'handler must be a function'
  | 'disposer must be a function if provided'
  | 'handlerTimeoutMs must be an integer >= 100 if provided'
  | 'You must use defineFluxionModule to create module';

/**
 * Validate a value loaded from disk. Pure: returns the defect instead of logging it, so the caller decides
 * what to do with it.
 */
export function rejectModule(o: unknown): ModuleRejection | undefined {
  if (typeof o !== 'object' || o === null) {
    return 'You must use defineFluxionModule to create module';
  }

  const m = o as NormalizedModule;

  if (typeof m.handler !== 'function') {
    return 'handler must be a function';
  }
  if (m.disposer !== undefined && typeof m.disposer !== 'function') {
    return 'disposer must be a function if provided';
  }

  const ms = m.handlerTimeoutMs;
  if (ms !== undefined && (!Number.isSafeInteger(ms) || ms < 100)) {
    return 'handlerTimeoutMs must be an integer >= 100 if provided';
  }
  if (m.type !== ModuleType.Api) {
    return 'You must use defineFluxionModule to create module';
  }
  return undefined;
}

/**
 * Attach the load metadata to a freshly loaded module.
 *
 * The spread is deliberate: the object was created by user code and is kept in the module cache, so it must
 * not be mutated in place.
 */
export const normalizeModule = (m: NormalizedModule, absolutePath: string, stat: Stats): NormalizedModule => ({
  ...m,
  absolutePath,
  mtimeMs: stat.mtimeMs,
});

/**
 * Pick the module out of a file's exports: a `defineFluxionModule` result is usable as `default` or as the
 * export object itself.
 */
export function selectModule(exports: any): { module?: NormalizedModule; rejection?: ModuleRejection } {
  const asDefault = rejectModule(exports?.default);
  if (asDefault === undefined) {
    return { module: exports.default };
  }
  const asExports = rejectModule(exports);
  if (asExports === undefined) {
    return { module: exports };
  }
  // The `default` export is what a handler file is expected to provide, so report its defect.
  return { rejection: asDefault };
}
