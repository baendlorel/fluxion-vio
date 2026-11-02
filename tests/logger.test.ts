import { describe, expect, test, vi } from 'vitest';
import { createLogger, formatError, type LogEntry } from '../src/common/logger.js';
import { defineFluxionOptions } from '../src/defines/options.js';
import type { FluxionContext } from '../src/types.js';

const makeOptions = (logger?: string | ((entry: LogEntry) => void)) =>
  defineFluxionOptions({ dir: '.', host: '127.0.0.1', port: 19_900, logger: logger as any });

const makeLogger = (logger?: any, entries?: LogEntry[]) => {
  const options = makeOptions(entries ? (entry: LogEntry) => entries.push(entry) : logger);
  return { options, logger: createLogger({ options } as Pick<FluxionContext, 'options'>) };
};

const collect = () => {
  const entries: LogEntry[] = [];
  const log = () => makeLogger(undefined, entries).logger;
  return { entries, log };
};

describe('logger entry shape', () => {
  test('a primitive payload becomes the action field', () => {
    const { entries, log } = collect();
    const logger = log();
    logger.info('hello');
    logger.warn(42);
    logger.error(true);

    expect(entries[0]).toMatchObject({ level: 'INFO', action: 'hello' });
    expect(entries[1]).toMatchObject({ level: 'WARN', action: 42 });
    expect(entries[2]).toMatchObject({ level: 'ERROR', action: true });
  });

  test('an object payload is spread over the default fields', () => {
    const { entries, log } = collect();
    log().error({ action: 'RequestFailed', method: 'GET' });

    expect(entries[0]).toMatchObject({ level: 'ERROR', action: 'RequestFailed', method: 'GET' });
  });

  test('user fields override the default timestamp, level and action', () => {
    const { entries, log } = collect();
    log().info({ level: 'CUSTOM', action: 'mine' });

    expect(entries[0]).toMatchObject({ level: 'CUSTOM', action: 'mine' });
  });

  test('timestamp is generated for each call', () => {
    const { entries, log } = collect();
    const logger = log();
    logger.info('a');
    logger.info('b');

    expect(typeof entries[0].timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(entries[0].timestamp))).toBe(false);
  });
});

describe('formatError', () => {
  test('joins message and stack with a newline', () => {
    const error = new Error('boom');
    expect(formatError(error)).toBe(`boom\n${error.stack}`);
  });

  test('passes through non-error values', () => {
    expect(formatError('nope')).toBe('nope');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
  });

  test('handles objects with only a message', () => {
    expect(formatError({ message: 'plain' })).toBe('plain');
  });
});

describe('json-line output', () => {
  test('serializes an Error field to its message and stack', () => {
    const options = makeOptions();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const error = new Error('failed');
      createLogger({ options } as Pick<FluxionContext, 'options'>).error({ action: 'RequestFailed', error });
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.action).toBe('RequestFailed');
      expect(parsed.error).toBe(`failed\n${error.stack}`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('logger options', () => {
  test('json-line is the default and prints one JSON object per line', () => {
    const options = makeOptions();
    expect(options.logger).toBe('json-line');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createLogger({ options } as Pick<FluxionContext, 'options'>).info({ action: 'x', a: 1 });
      const line = spy.mock.calls[0][0] as string;
      expect(JSON.parse(line)).toMatchObject({ level: 'INFO', action: 'x', a: 1 });
      expect(line).not.toContain('\n');
    } finally {
      spy.mockRestore();
    }
  });

  test('one-line is no longer accepted', () => {
    expect(() => makeOptions('one-line')).toThrow(/json-line/);
  });

  test('a custom logger function is used as-is', () => {
    const entries: LogEntry[] = [];
    makeLogger((entry: LogEntry) => entries.push(entry)).logger.succ('done');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'SUCC', action: 'done' });
  });
});
