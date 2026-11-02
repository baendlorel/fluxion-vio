import type { InternalFluxionLogger } from './logger.js';
import { formatError } from './logger.js';

/**
 * How long after `fluxion()` finishes before memory is first sampled, in ms.
 * Application code that runs right after `await fluxion()` — opening database
 * connections, warming caches — allocates memory that is not bloat, so the
 * first check waits for it to settle.
 */
const STARTUP_GRACE_MS = 5000;

/** How often resident memory is sampled after the grace period, in ms. */
const MEMORY_CHECK_INTERVAL_MS = 10_000;

/** How long to wait for in-flight connections to finish before cutting them. */
const CLOSE_TIMEOUT_MS = 5000;

/**
 * The parts of `http.Server` / `https.Server` the restart path needs. Both
 * classes provide them, but `https.Server` does not extend `http.Server`.
 */
interface Listener {
  close(cb?: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export interface RestarterOptions {
  /**
   * Resident-memory threshold in MB. `false` disables the monitor.
   */
  restartMemoryMB: number | false;
  /** The listener to close before the image is replaced. */
  server: Listener;
  logger: InternalFluxionLogger;
  /**
   * Swap in another grace period, e.g. for tests.
   */
  startupGraceMs?: number;
  /**
   * Swap in another check interval, e.g. for tests.
   */
  checkIntervalMs?: number;
}

export interface Restarter {
  /**
   * Start the grace period and, after it, the periodic sampling. Call as the
   * last step of startup so the grace period covers the caller's own init.
   */
  start(): void;
  /**
   * Stop sampling memory. Safe to call before {@link start}.
   */
  stop(): void;
}

const megabytes = (bytes: number) => bytes / (1024 * 1024);

/**
 * `process.execve` exists from Node.js 22.15 on Linux and macOS.
 */
export const supportsInPlaceRestart = (): boolean => typeof process.execve === 'function';

/**
 * Resolve once the server has closed, or after `timeoutMs` — a keep-alive
 * connection that never goes away must not block the restart forever.
 */
function closeServer(server: Listener, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      done();
    }, timeoutMs);
    timer.unref();

    server.close(done);
    server.closeIdleConnections();
  });
}

/**
 * Rebuild the command line the process was started with. `tsx` and other
 * loaders live in `execArgv`, so dropping it would start the entry point
 * unparsed.
 */
const commandLine = () => [process.execPath, ...process.execArgv, ...process.argv.slice(1)];

/**
 * Replace the running process image with a fresh copy of itself, keeping the
 * PID. Listeners must be closed and the log flushed before the call: execve
 * only preserves stdio.
 *
 * Never returns on success — the entry point is re-executed in the same
 * process. On failure the process exits with code 1 so a supervisor restarts
 * it.
 */
export async function restartInPlace(
  server: Listener,
  logger: InternalFluxionLogger,
  extra: Record<string, unknown> = {},
): Promise<never> {
  if (typeof process.execve !== 'function') {
    // Callers check `supportsInPlaceRestart` first; keep this for direct use.
    logger.error({ event: 'RestartFailed', pid: process.pid, error: 'process.execve is not available' });
    process.exit(1);
  }

  logger.warn({ event: 'Restarting', pid: process.pid, ...extra });

  await closeServer(server);
  await logger.flush();

  try {
    process.execve(process.execPath, commandLine(), process.env);
  } catch (e) {
    logger.error({ event: 'RestartFailed', pid: process.pid, error: formatError(e) });
  }
  process.exit(1);
}

/**
 * Watch RSS and run {@link restartInPlace} once it crosses the threshold.
 * Returns a no-op restarter when the threshold is `false`.
 *
 * Call this as the last step of `fluxion()`: the grace period is measured from
 * that moment. The timers are unref'd, so they never keep the process alive on
 * their own.
 */
export function watchMemory(options: RestarterOptions): Restarter {
  const {
    restartMemoryMB,
    server,
    logger,
    startupGraceMs = STARTUP_GRACE_MS,
    checkIntervalMs = MEMORY_CHECK_INTERVAL_MS,
  } = options;

  if (restartMemoryMB === false) {
    return { start: () => {}, stop: () => {} };
  }

  let restarting = false;
  let timer: NodeJS.Timeout | undefined;

  const check = () => {
    if (restarting) return;
    const rssMB = megabytes(process.memoryUsage.rss());
    if (rssMB <= restartMemoryMB) return;

    restarting = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    // Not awaited: the call ends the process, and the interval callback must
    // not keep the event loop busy while listeners drain.
    void restartInPlace(server, logger, { reason: 'memory', rssMB: Math.round(rssMB) });
  };

  return {
    start() {
      if (timer !== undefined || restarting) return;
      // Skip the startup phase entirely; the first sample lands when user code
      // has had time to finish its own initialization.
      timer = setTimeout(() => {
        timer = setInterval(check, checkIntervalMs);
        timer.unref();
        check();
      }, startupGraceMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
