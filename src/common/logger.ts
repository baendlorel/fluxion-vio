import type { FluxionContext } from '@/types.js';
import type { otherstring } from '@/types.js';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type LogLevel = 'CORE' | 'INFO' | 'WARN' | 'ERROR' | 'SUCC' | 'DEBUG' | 'VERBOSE' | otherstring;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event?: unknown;
  [key: string]: unknown;
}

/**
 * 'json-line' 每行写一个 JSON 对象。刻意不内置单行模式：需要的话用 {@link defineFluxionLogger} 自己写。
 */
export type LoggerOption = 'json-line' | FluxionLoggerFn;

export type FluxionLoggerFn = (entry: LogEntry) => void;

/** 日志载荷：普通对象会把字段合并进条目，原始值则成为 event 字段。 */
export type LogPayload = string | number | boolean | bigint | null | undefined | MessageObject;

export interface MessageObject {
  [key: string]: unknown;
  event?: unknown;
}

export interface FluxionLogger {
  /** 原始值成为 event；对象载荷会覆盖默认的 timestamp、level、event 字段。 */
  write(level: LogLevel, payload: LogPayload): void;
  info(payload: LogPayload): void;
  warn(payload: LogPayload): void;
  error(payload: LogPayload): void;
  succ(payload: LogPayload): void;
  debug(payload: LogPayload): void;
  verbose(payload: LogPayload): void;
}

/**
 * 仅供框架内部（router、injector 等）使用的 logger。
 * 在公开的 {@link FluxionLogger} 之上增加了 core 级别，用来记录框架自身的日志
 * （如路由解析、模块生命周期），以便和用户 handler 的日志区分开。
 *
 * ! 此类型不导出给应用代码：{@link FluxionModuleContext} 只暴露 {@link FluxionLogger}，core 不对用户开放。
 */
export interface InternalFluxionLogger extends FluxionLogger {
  core(payload: LogPayload): void;
}

const isMessageObject = (payload: LogPayload): payload is MessageObject =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload);

/** ! Error.isError 需要 Node.js 24 */
const isError = (value: unknown): value is Error =>
  typeof Error.isError === 'function' ? Error.isError(value) : value instanceof Error;

/** 把任何抛出值转成可打印字符串：message，有 stack 时再换行接上。 */
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
  // Error 直接序列化会变成 {}，所以展开成 message + stack。
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

/** 把一条日志序列化成单行 JSON。 */
const safeStringify = (entry: LogEntry): string => {
  try {
    return JSON.stringify(entry, jsonReplacer) ?? fallbackLine(entry);
  } catch {
    return fallbackLine(entry);
  }
};

/** 默认输出：stdout 上每行一个 JSON 对象。 */
export const jsonLineLogger: FluxionLoggerFn = (entry: LogEntry) => {
  // eslint-disable-next-line no-console
  console.log(safeStringify(entry));
};

/** 创建文件日志写入器。 */
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

/** 此处的 logger 选项已在 options 规范化阶段校验过。 */
function resolveLoggerSink(cx: Pick<FluxionContext, 'options'>): FluxionLoggerFn {
  const instanceLogPath = process.env.FLUXION_INSTANCE_LOG;
  const consoleSink = cx.options.logger === 'json-line' ? jsonLineLogger : cx.options.logger;

  if (!instanceLogPath) {
    return consoleSink;
  }

  const fileSink = createFileSink(instanceLogPath);
  return (entry: LogEntry) => {
    consoleSink(entry);
    fileSink(entry);
  };
}

export function createLogger(cx: Pick<FluxionContext, 'options'>): InternalFluxionLogger {
  const sink = resolveLoggerSink(cx);

  const write = (level: LogLevel, payload: LogPayload): void => {
    // 默认字段先插入；展开在后的用户字段可以覆盖 timestamp、level、event。
    const timestamp = new Date().toISOString();
    const entry: LogEntry = isMessageObject(payload)
      ? { timestamp, level, event: payload.event, ...payload }
      : { timestamp, level, event: payload };

    try {
      sink(entry);
    } catch {
      // 忽略日志输出失败，避免影响请求处理。
    }
  };

  return {
    write,
    info: (payload) => write('INFO', payload),
    warn: (payload) => write('WARN', payload),
    error: (payload) => write('ERROR', payload),
    succ: (payload) => write('SUCC', payload),
    debug: (payload) => write('DEBUG', payload),
    verbose: (payload) => write('VERBOSE', payload),
    core: (payload) => write('CORE', payload),
  };
}
