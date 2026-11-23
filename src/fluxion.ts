import type { FluxionContext, FluxionController, FluxionOptions, NormalizedFluxionOptions } from './types.js';

import { createLogger } from './common/logger.js';
import { type ModuleCache } from './common/loader.js';
import { redirectOutput } from './common/output.js';
import { flags } from './common/consts.js';
import { defineFluxionOptions } from './defines/options.js';
import { createServer, type ListeningServer } from './http/server.js';
import { createRouter } from './router/index.js';

// TODO 为了更加接近原生的php行为，还可以采用进程运行法，把spawn的tsx的stdio捕获后，完成返回。
// 类似于const result = execSync('tsx your-script.ts', { stdio: 'pipe' }); 然后让接口返回result.

/**
 * Build the controller handed back to the caller.
 *
 * `stop` is synchronous and idempotent: it aborts the instance's signal (which abandons every middleware and
 * handler still racing it), then closes the listener and destroys the remaining sockets, so no request can
 * outlive the call.
 */
function createController(cx: FluxionContext, server: ListeningServer): FluxionController {
  const stop = (): void => {
    if (cx.signal.aborted) {
      return;
    }
    cx.abort();
    cx.logger.warn({ event: 'Stopped', pid: process.pid });
    // `close` stops new connections; `closeAllConnections` cuts the current ones so nothing keeps running.
    server.close();
    server.closeAllConnections();
  };

  return { stop };
}

/**
 * Creates a fluxion-vio server instance.
 *
 * Signal handling belongs to the caller: bind `SIGINT` / `SIGTERM` yourself and call `controller.stop()`.
 * @package Fluxion Vio
 * @version __VERSION__
 */
export async function fluxion(options: FluxionOptions): Promise<FluxionController> {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Invalid fluxion options: expected an object');
  }

  const alreadyNormalized = (options as NormalizedFluxionOptions).normalizedFlag === flags.OptionsNormalized;
  const normalized = alreadyNormalized ? (options as NormalizedFluxionOptions) : defineFluxionOptions(options);

  // Before anything is logged, so a startup failure (a busy port) lands in the file too.
  if (normalized.logOutputFile) {
    await redirectOutput(normalized.logOutputFile);
  }

  const logger = createLogger({ options: normalized });
  const moduleCache: ModuleCache = new Map();
  const router = createRouter({ options: normalized, logger, moduleCache });

  // One abort controller per instance. Its signal is what the request path races against, so `stop` reaches
  // handlers that are already running without them having to be tracked anywhere.
  const lifecycle = new AbortController();

  // The cache and the router are per instance: nothing loaded by one `fluxion()` call is visible to another.
  const context: FluxionContext = {
    options: normalized,
    logger,
    moduleCache,
    router,
    signal: lifecycle.signal,
    abort: () => lifecycle.abort(),
  };

  const server = await createServer(context);

  return createController(context, server);
}
