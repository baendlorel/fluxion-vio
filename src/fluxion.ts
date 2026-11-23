import type { FluxionContext, FluxionOptions, NormalizedFluxionOptions } from './types.js';

import { createLogger } from './common/logger.js';
import { type ModuleCache } from './common/loader.js';
import { redirectOutput } from './common/output.js';
import { flags } from './common/consts.js';
import { defineFluxionOptions } from './defines/options.js';
import { createServer } from './http/server.js';
import { createRouter } from './router/index.js';

// TODO 为了更加接近原生的php行为，还可以采用进程运行法，把spawn的tsx的stdio捕获后，完成返回。
// 类似于const result = execSync('tsx your-script.ts', { stdio: 'pipe' }); 然后让接口返回result.

/**
 * Creates a fluxion-vio server instance.
 * @package Fluxion Vio
 * @version __VERSION__
 */
export async function fluxion(options: FluxionOptions) {
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

  // The cache and the router are per instance: nothing loaded by one `fluxion()` call is visible to another.
  const context: FluxionContext = { options: normalized, logger, moduleCache, router };

  await createServer(context);

  const shutdown = (signal: NodeJS.Signals) => {
    logger.warn({ event: 'ShuttingDown', pid: process.pid, signal });
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
