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

/** [是否成立, 错误信息] 二元组：不成立时抛出该信息。 */
type Rule = readonly [holds: boolean, message: string];

/** 抛出第一条不成立的规则信息。 */
const assert = (rules: readonly Rule[]): void => {
  const message = rules.find(([holds]) => !holds)?.[1];
  if (message !== undefined) {
    throw new FluxionError(message);
  }
};

/**
 * 用 handler（和可选的 disposer）定义 Fluxion 模块。
 * @param handler 处理请求与响应的主函数
 * @param disposer 响应发出后的资源清理，可选
 */
export function defineFluxionModule(handler: FluxionHandler, disposer?: FluxionDisposer): FluxionModuleObject;
/** 以对象形式定义模块，提供类型提示。 */
export function defineFluxionModule(fluxionModule: FluxionModule): FluxionModuleObject;
export function defineFluxionModule(
  a: FluxionModule | FluxionHandler,
  disposer?: FluxionDisposer,
): FluxionModuleObject {
  if (typeof a === 'function') {
    assert([[disposer === undefined || typeof disposer === 'function', `Invalid disposer, expected a function but got ${typeof disposer}`]]);
    return { handler: a, disposer, type: ModuleType.Api };
  }

  assert([
    [typeof a === 'object' && a !== null, `Invalid argument, expected a FluxionModule object or a handler function, but got ${typeof a}`],
    [typeof a.handler === 'function', `Invalid FluxionModule, "handler" must be a function`],
    [a.disposer === undefined || typeof a.disposer === 'function', `Invalid FluxionModule, "disposer" must be a function if provided`],
    [a.methods === undefined || (Array.isArray(a.methods) && a.methods.every((v) => typeof v === 'string')), `Invalid FluxionModule, "methods" must be an array of strings if provided`],
    [a.middlewares === undefined || (Array.isArray(a.middlewares) && a.middlewares.every((v) => typeof v === 'function')), `Invalid FluxionModule, "middlewares" must be an array of functions if provided`],
  ]);

  return { ...a, type: ModuleType.Api };
}

export function defineFluxionMiddleware(middleware: FluxionMiddleware): FluxionMiddleware {
  assert([[typeof middleware === 'function', `Invalid FluxionMiddleware, expected a function but got ${typeof middleware}`]]);
  return middleware;
}

export function defineFluxionLogger(loggerFn: FluxionLoggerFn) {
  assert([[typeof loggerFn === 'function', `Invalid FluxionLoggerFn, expected a function but got ${typeof loggerFn}`]]);
  return loggerFn;
}
