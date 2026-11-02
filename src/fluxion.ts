import type { FluxionContext, FluxionOptions, NormalizedFluxionOptions } from './types.js';

import { createLogger } from './common/logger.js';
import { redirectOutput } from './common/output.js';
import { flags } from './common/consts.js';
import { supportsInPlaceRestart, watchMemory } from './common/restart.js';
import { defineFluxionOptions } from './defines/options.js';
import { createServer } from './http/server.js';
import { createRouter } from './router/index.js';

/**
 * Creates a fluxion-vio server instance.
 * @package Fluxion Vio
 * @version __VERSION__
 */
export async function fluxion(options: FluxionOptions | NormalizedFluxionOptions) {
  const alreadyNormalized = (options as NormalizedFluxionOptions).normalizedFlag === flags.OptionsNormalized;
  const context = { options: alreadyNormalized ? options : defineFluxionOptions(options) } as FluxionContext;

  // Before anything is logged, so a startup failure (a busy port) lands in the file too.
  if (context.options.logOutputFile) {
    await redirectOutput(context.options.logOutputFile);
  }

  // A restart must drain the log before execve replaces the image, so the file
  // sink is flushed explicitly instead of closing itself. On runtimes without
  // `process.execve` the option is ignored, so there is nothing to flush for.
  const restartable = context.options.restartMemoryMB !== false && supportsInPlaceRestart();
  context.logger = createLogger(context as Pick<FluxionContext, 'options'>, { deferClose: restartable });
  context.router = createRouter(context as Pick<FluxionContext, 'options' | 'logger'>);

  // Start HTTP server
  const server = await createServer(context);

  if (context.options.restartMemoryMB !== false && !restartable) {
    context.logger.warn({
      event: 'RestartDisabled',
      reason: 'process.execve is not available on this Node.js version',
      requiredVersion: '22.15',
      nodeVersion: process.version,
      restartMemoryMB: context.options.restartMemoryMB,
    });
  }

  const restarter = watchMemory({
    restartMemoryMB: restartable ? context.options.restartMemoryMB : false,
    server,
    logger: context.logger,
  });

  // Register signal handlers for graceful shutdown
  const shutdown = (signal: NodeJS.Signals) => {
    restarter.stop();
    context.logger.warn({ event: 'ShuttingDown', pid: process.pid, signal });
    server.close(async () => {
      await context.logger.flush();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // ! This must stay the last step: the memory monitor's startup grace period
  // is measured from here, giving the caller's own initialization (database
  // connections, caches) time to settle before memory is judged.
  restarter.start();
}
