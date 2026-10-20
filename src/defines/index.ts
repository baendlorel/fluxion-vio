import { FluxionError } from '@/common/error.js';
import type {
  FluxionHandler,
  FluxionDisposer,
  FluxionModule,
  FluxionMiddleware,
  FluxionModuleObject,
} from '@/types.js';
import type { FluxionLoggerFn } from '@/common/logger.js';
import { ModuleType } from '@/common/consts.js';

export { defineFluxionOptions } from './options.js';

/**
 * Use handler function and optional disposer function to define a Fluxion module.
 * @param handler Main function that handles request and response instances
 * @param disposer Deal with resource cleanup when the server is about to close
 */
export function defineFluxionModule(handler: FluxionHandler, disposer?: FluxionDisposer): FluxionModuleObject;
/**
 * Provides type safety for defining Fluxion modules.
 */
export function defineFluxionModule(fluxionModule: FluxionModule): FluxionModuleObject;
export function defineFluxionModule(
  a: FluxionModule | FluxionHandler,
  disposer?: FluxionDisposer,
): FluxionModuleObject {
  if (typeof a === 'function') {
    if (disposer !== undefined && typeof disposer !== 'function') {
      throw new FluxionError(`Invalid disposer, expected a function but got ${typeof disposer}`);
    }
    return { handler: a, disposer, type: ModuleType.Api };
  }

  if (typeof a !== 'object' || a === null) {
    throw new FluxionError(
      `Invalid argument, expected a FluxionModule object or a handler function, but got ${typeof a}`,
    );
  }

  if (typeof a.handler !== 'function') {
    throw new FluxionError(`Invalid FluxionModule, "handler" must be a function`);
  }

  if (a.disposer !== undefined && typeof a.disposer !== 'function') {
    throw new FluxionError(`Invalid FluxionModule, "disposer" must be a function if provided`);
  }

  if (a.methods !== undefined && (!Array.isArray(a.methods) || a.methods.some((v) => typeof v !== 'string'))) {
    throw new FluxionError(`Invalid FluxionModule, "methods" must be an array of strings if provided`);
  }

  if (
    a.middlewares !== undefined &&
    (!Array.isArray(a.middlewares) || a.middlewares.some((v) => typeof v !== 'function'))
  ) {
    throw new FluxionError(`Invalid FluxionModule, "middlewares" must be an array of functions if provided`);
  }

  return { ...a, type: ModuleType.Api };
}

export function defineFluxionMiddleware(middleware: FluxionMiddleware): FluxionMiddleware {
  if (typeof middleware !== 'function') {
    throw new FluxionError(`Invalid FluxionMiddleware, expected a function but got ${typeof middleware}`);
  }
  return middleware;
}

export function defineFluxionLogger(loggerFn: FluxionLoggerFn) {
  if (typeof loggerFn !== 'function') {
    throw new FluxionError(`Invalid FluxionLoggerFn, expected a function but got ${typeof loggerFn}`);
  }
  return loggerFn;
}
