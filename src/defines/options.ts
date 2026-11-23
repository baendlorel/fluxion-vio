import { FluxionError } from '@/common/error.js';
import type { FluxionOptions, NormalizedFluxionOptions } from '@/types.js';
import fs from 'node:fs';
import path from 'node:path';

import { flags } from '@/common/consts.js';

/**
 * Read certificate content from a file path or return the content directly.
 * Relative paths are resolved against the current working directory.
 */
function readCertificateContent(content: string | Buffer): Buffer {
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (typeof content === 'string') {
    // Check if it looks like a file path (not a PEM certificate)
    // PEM certificates start with "-----BEGIN"
    if (!content.startsWith('-----BEGIN')) {
      const filePath = path.resolve(content);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
      }
    }
    return Buffer.from(content);
  }
  throw new FluxionError('Certificate content must be a string or Buffer');
}

/**
 * Normalize HTTPS options.
 */
function normalizeHttpsOptions(https: FluxionOptions['https']): NormalizedFluxionOptions['https'] | undefined {
  if (!https) {
    return undefined;
  }

  if (typeof https !== 'object' || https === null || Array.isArray(https)) {
    throw new FluxionError('FluxionOptions.https must be an object');
  }
  if (typeof https.key !== 'string' && !Buffer.isBuffer(https.key)) {
    throw new FluxionError('FluxionOptions.https.key must be a string or Buffer');
  }
  if (typeof https.cert !== 'string' && !Buffer.isBuffer(https.cert)) {
    throw new FluxionError('FluxionOptions.https.cert must be a string or Buffer');
  }

  const result: NormalizedFluxionOptions['https'] = {
    key: readCertificateContent(https.key),
    cert: readCertificateContent(https.cert),
  };

  if (https.ca !== undefined) {
    if (Array.isArray(https.ca)) {
      result.ca = https.ca.map((item) => readCertificateContent(item));
    } else {
      result.ca = readCertificateContent(https.ca);
    }
  }

  return result;
}

/** A `[holds, message]` pair: the message is thrown when `holds` is false. */
type Rule = readonly [holds: boolean, message: string];

/** Return the first failing rule's message, or `undefined` when every rule holds. */
const firstViolation = (rules: readonly Rule[]): string | undefined => rules.find(([holds]) => !holds)?.[1];

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.vscode/**',
  '**/.idea/**',
  '**/*.log',
  '**/.DS_Store',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/*.tmp',
  '**/*.temp',
];

const INCLUDE_REMOVED = [
  'The "include" option has been removed. Please use:',
  '  - "apiInclude" for API handler patterns (default: ["**/*.ts"])',
  '  - "staticInclude" for static resource patterns (default: ["**/*"])',
  'Example migration:',
  '  OLD: { include: ["**/*.ts", "**/*.js"], apiInclude: ["**/*.ts"] }',
  '  NEW: { apiInclude: ["**/*.ts"], staticInclude: ["**/*.js"] }',
].join('\n');

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((item) => typeof item === 'string');

/**
 * Normalize options and create necessary resources like the dynamic directory and logger.
 */
export function defineFluxionOptions(o: FluxionOptions): NormalizedFluxionOptions {
  const {
    dir: rawDir,
    host,
    port: userPort,
    handlerTimeoutMs = 5000,
    middlewareTimeoutMs = 3000,
    staticResourceTimeoutMs = 3 * 60 * 1000,
    target = `node${process.versions.node.split('.')[0]}`,
    maxRequestBytes = 8_000_000,
    apiInclude = ['**/*.ts'],
    staticInclude = ['**/*'],
    exclude = DEFAULT_EXCLUDE,
    https,
    csp = "default-src 'self'",
    logOutputFile: rawLogOutputFile,
  } = o as FluxionOptions;

  const port = userPort;
  const logger = o.logger ?? 'json-line';

  const violation = firstViolation([
    [typeof o === 'object' && o !== null && !Array.isArray(o), 'FluxionOptions must be an object'],
    [!(typeof o === 'object' && o !== null && 'include' in o), INCLUDE_REMOVED],
    [logger === 'json-line' || typeof logger === 'function', `Invalid logger option, Must be 'json-line' or a custom logger function (write a one-line logger yourself)`],
    [typeof rawDir === 'string', 'FluxionOptions.dir must be a string'],
    [typeof target === 'string' || isStringArray(target), 'FluxionOptions.target must be a string or an array of strings'],
    [typeof host === 'string', 'FluxionOptions.host must be a string'],
    [Number.isSafeInteger(handlerTimeoutMs) && handlerTimeoutMs > 100, 'FluxionOptions.handlerTimeoutMs must be an integer greater than 100'],
    [Number.isSafeInteger(middlewareTimeoutMs) && middlewareTimeoutMs > 100, 'FluxionOptions.middlewareTimeoutMs must be an integer greater than 100'],
    [typeof port === 'number' && Number.isSafeInteger(port), 'FluxionOptions.port must be a positive integer'],
    [port > 1 && port <= 65535, 'FluxionOptions.port must be 1 ~ 65535'],
    [typeof maxRequestBytes === 'number' && maxRequestBytes > 0 && Number.isSafeInteger(maxRequestBytes), 'FluxionOptions.maxRequestBytes must be a positive integer'],
    [csp === false || typeof csp === 'string', 'FluxionOptions.csp must be a string or false'],
    [rawLogOutputFile === undefined || (typeof rawLogOutputFile === 'string' && rawLogOutputFile.length > 0), 'FluxionOptions.logOutputFile must be a non-empty string path'],
    [isStringArray(apiInclude), 'FluxionOptions.apiInclude must be an array of glob strings'],
    [isStringArray(staticInclude), 'FluxionOptions.staticInclude must be an array of glob strings'],
    [isStringArray(exclude), 'FluxionOptions.exclude must be an array of glob strings'],
  ]);

  if (violation !== undefined) {
    throw new FluxionError(violation);
  }

  // Ends with a separator, so "is this file under dir" is a plain `startsWith`
  const resolvedDir = path.resolve(process.cwd(), rawDir);
  const dir = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  // Relative paths follow `dir` and `https`: resolved against the cwd.
  const logOutputFile = rawLogOutputFile === undefined ? undefined : path.resolve(process.cwd(), rawLogOutputFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const result: NormalizedFluxionOptions = {
    dir,
    host,
    port,
    handlerTimeoutMs,
    middlewareTimeoutMs,
    staticResourceTimeoutMs,
    target,
    maxRequestBytes,
    logger,
    logOutputFile,
    apiInclude,
    staticInclude,
    exclude,
    https: normalizeHttpsOptions(https),
    csp,
    normalizedFlag: flags.OptionsNormalized,
  };

  if (process.argv.includes('--verbose')) {
    console.log('normalized options', { ...result, https: result.https ? 'set' : 'unset' });
  }

  return result;
}
