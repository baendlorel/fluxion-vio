import { FluxionError } from './error.js';
import type { FluxionContext, NormalizedModule } from '@/types.js';
import type { Stats } from 'node:fs';
import { static_cast } from 'type-narrow';
import { ModuleType } from './consts.js';
import { FluxionLoader } from './loader.js';

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

export function loadFluxionModule(
  cx: Pick<FluxionContext, 'options' | 'logger'>,
  absolutePath: string,
  stat: Stats,
): NormalizedModule {
  const loader = new FluxionLoader(cx.options);

  let m = loader.require(absolutePath);
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
