import type { NormalizedModule } from '@/types.js';
import { ModuleType } from './consts.js';

/** 一个值不能用作 NormalizedModule 的原因。 */
export const enum ModuleRejection {
  HandlerMustBeFunction = 'handler must be a function',
  DisposerMustBeFunctionIfProvided = 'disposer must be a function if provided',
  HandlerTimeoutMsMustBeInteger = 'handlerTimeoutMs must be an integer >= 100 if provided',
  MustUseDefineFluxionModule = 'You must use defineFluxionModule to create module',
}

/** 校验从磁盘加载的值。纯函数：只返回缺陷而不记日志，如何处理由调用方决定。 */
function resolveModule(o: unknown): ModuleRejection | undefined {
  if (typeof o !== 'object' || o === null) {
    return ModuleRejection.MustUseDefineFluxionModule;
  }

  const m = o as NormalizedModule;

  if (typeof m.handler !== 'function') {
    return ModuleRejection.HandlerMustBeFunction;
  }
  if (m.disposer !== undefined && typeof m.disposer !== 'function') {
    return ModuleRejection.DisposerMustBeFunctionIfProvided;
  }

  const ms = m.handlerTimeoutMs;
  if (ms !== undefined && (!Number.isSafeInteger(ms) || ms < 100)) {
    return ModuleRejection.HandlerTimeoutMsMustBeInteger;
  }
  if (m.type !== ModuleType.Api) {
    return ModuleRejection.MustUseDefineFluxionModule;
  }
  return undefined;
}

/**
 * 从文件 exports 中取出模块：defineFluxionModule 的结果可以放在 default，也可以是 exports 本身。
 */
export function selectModule(exports: any): { module?: NormalizedModule; rejection?: ModuleRejection } {
  const asDefault = resolveModule(exports?.default);
  if (asDefault === undefined) {
    return { module: exports.default };
  }
  const asExports = resolveModule(exports);
  if (asExports === undefined) {
    return { module: exports };
  }
  // handler 文件应当提供 default 导出，所以报告它的缺陷。
  return { rejection: asDefault };
}
