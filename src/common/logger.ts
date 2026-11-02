import type { FluxionContext } from '@/types.js';
import type { otherstring } from '@/types.js';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

type LogLevel = 'CORE' | 'INFO' | 'WARN' | 'ERROR' | 'SUCC' | 'DEBUG' | 'VERBOSE' | otherstring;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event?: unknown;
  [key: string]: unknown;
}

/**
 * `'json-line'` writes one JSON object per line. `one-line` is intentionally
 * not built in: write your own function with {@link defineFluxionLogger}.
 */
export type LoggerOption = 'json-line' | FluxionLoggerFn;

export type FluxionLoggerFn = (entry: LogEntry) => void;

/**
 * A log payload is either a plain object, whose fields are merged into the
 * entry, or a primitive, which becomes the `event` field.
 */
export type LogPayload = string | number | boolean | bigint | null | undefined | MessageObject;

export interface MessageObject {
  [key: string]: unknown;
  event?: unknown;
}

export interface FluxionLogger {
  /**
   * Primitive payloads become `event`; object payloads are spread over the
   * default `timestamp`, `level` and `event` fields.
   */
  write(level: LogLevel, payload: LogPayload): void;
  info(payload: LogPayload): void;
  warn(payload: LogPayload): void;
  error(payload: LogPayload): void;
  succ(payload: LogPayload): void;
  debug(payload: LogPayload): void;
  verbose(payload: LogPayload): void;
}

/**
 * Internal-only logger used by fluxion's own subsystems (router, injector,
 * ...). It extends the public {@link FluxionLogger}
 * with a `core` level that records framework-originated logs — e.g. route
 * registration, module lifecycle — so they are visually distinct
 * from logs emitted by user handlers.
 *
 * ! This type is NOT exported to application code: {@link FluxionModuleContext}
 * exposes only {@link FluxionLogger}, keeping
 * `core` off-limits to user handlers.
 */
export interface InternalFluxionLogger extends FluxionLogger {
  core(payload: LogPayload): void;
}

const isMessageObject = (payload: LogPayload): payload is MessageObject =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload);

/**
 * ! Error.isError needs Node.js 24
 */
const isError = (value: unknown): value is Error =>
  typeof Error.isError === 'function' ? Error.isError(value) : value instanceof Error;

/**
 * Turn anything thrown or passed as an error into a printable string:
 * the `message`, followed by the `stack` on the next line when present.
 */
export function formatError(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const { message, stack } = e as { message?: unknown; stack?: unknown };
    let text = '';
    if (typeof message === 'string' && message.length > 0) {
      text = message;
    }
    if (typeof stack === 'string' && stack.length > 0) {
      text += (text.length > 0 ? '\n' : '') + stack;
    }
    if (text.length > 0) {
      return text;
    }
  }
  return String(e);
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  // Errors serialize to `{}` on their own, so expand them to message + stack.
  if (isError(value)) {
    return formatError(value);
  }
  return value;
};

const fallbackLine = (entry: LogEntry): string =>
  JSON.stringify({
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : String(entry.timestamp),
    level: typeof entry.level === 'string' ? entry.level : 'INFO',
    event: '[unserializable]',
  });

/**
 * Serialize one entry as a single JSON line.
 */
const safeStringify = (entry: LogEntry): string => {
  try {
    return JSON.stringify(entry, jsonReplacer) ?? fallbackLine(entry);
  } catch {
    return fallbackLine(entry);
  }
};

/**
 * Default sink: one JSON object per line on stdout.
 */
export const jsonLineLogger: FluxionLoggerFn = (entry: LogEntry) => {
  // eslint-disable-next-line no-console
  console.log(safeStringify(entry));
};

/**
 * 创建文件日志写入器
 */
function createFileSink(logFilePath: string): FluxionLoggerFn {
  // 确保日志目录存在
  if (!existsSync(logFilePath)) {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const fileStream = createWriteStream(logFilePath, { flags: 'a' });

  return (entry: LogEntry) => {
    try {
      fileStream.write(safeStringify(entry) + '\n');
    } catch {
      // 忽略文件写入错误
    }
  };
}

/**
 * & Logger Options here is checked by normalizeOptions function.
 */
function resolveLoggerSink(cx: Pick<FluxionContext, 'options'>): FluxionLoggerFn {
  const instanceLogPath = process.env.FLUXION_INSTANCE_LOG;
  const fileSink = instanceLogPath ? createFileSink(instanceLogPath) : null;

  const loggerOption = cx.options.logger;
  const consoleSink = typeof loggerOption === 'function' ? loggerOption : jsonLineLogger;

  if (!fileSink) {
    return consoleSink;
  }

  return (entry: LogEntry) => {
    consoleSink(entry);
    fileSink(entry);
  };
}

export function createLogger(cx: Pick<FluxionContext, 'options'>): InternalFluxionLogger {
  const sink = resolveLoggerSink(cx);

  const logger: InternalFluxionLogger = {
    write(level: LogLevel, payload: LogPayload): void {
      // Default fields come first in insertion order; the spread lets a user
      // field override `timestamp`, `level` or `event`.
      const timestamp = new Date().toISOString();
      const entry: LogEntry = isMessageObject(payload)
        ? { timestamp, level, event: payload.event, ...payload }
        : { timestamp, level, event: payload };

      try {
        sink(entry);
      } catch {
        // Ignore logger sink failures to avoid breaking request handling.
      }
    },
    info(payload: LogPayload): void {
      this.write('INFO', payload);
    },
    warn(payload: LogPayload): void {
      this.write('WARN', payload);
    },
    error(payload: LogPayload): void {
      this.write('ERROR', payload);
    },
    succ(payload: LogPayload): void {
      this.write('SUCC', payload);
    },
    debug(payload: LogPayload): void {
      this.write('DEBUG', payload);
    },
    verbose(payload: LogPayload): void {
      this.write('VERBOSE', payload);
    },
    core(payload: LogPayload): void {
      this.write('CORE', payload);
    },
  };

  return logger;
}

/**
 * Create a worker logger that prefixes all log messages with the worker PID.
 */
export function createWorkerLogger(baseLogger: FluxionLogger, pid: number): InternalFluxionLogger {
  return {
    write(level: LogLevel, payload: LogPayload): void {
      baseLogger.write(level, isMessageObject(payload) ? { ...payload, pid } : { event: payload, pid });
    },
    info(payload: LogPayload): void {
      this.write('INFO', payload);
    },
    warn(payload: LogPayload): void {
      this.write('WARN', payload);
    },
    error(payload: LogPayload): void {
      this.write('ERROR', payload);
    },
    succ(payload: LogPayload): void {
      this.write('SUCC', payload);
    },
    debug(payload: LogPayload): void {
      this.write('DEBUG', payload);
    },
    verbose(payload: LogPayload): void {
      this.write('VERBOSE', payload);
    },
    core(payload: LogPayload): void {
      this.write('CORE', payload);
    },
  };
}
