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

/**
 * Normalize options and create necessary resources like the dynamic directory and logger.
 */
export function defineFluxionOptions(o: FluxionOptions): NormalizedFluxionOptions {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new FluxionError('FluxionOptions must be an object');
  }

  // Check for deprecated 'include' option
  if ('include' in o) {
    throw new FluxionError(
      'The "include" option has been removed. Please use:\n' +
        '  - "apiInclude" for API handler patterns (default: ["**/*.ts"])\n' +
        '  - "staticInclude" for static resource patterns (default: ["**/*"])\n' +
        'Example migration:\n' +
        '  OLD: { include: ["**/*.ts", "**/*.js"], apiInclude: ["**/*.ts"] }\n' +
        '  NEW: { apiInclude: ["**/*.ts"], staticInclude: ["**/*.js"] }',
    );
  }

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
    exclude = [
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
    ],
    https,
    csp = "default-src 'self'",
  } = o as FluxionOptions;

  const port = userPort;

  const logger = o.logger ?? 'one-line';
  if (logger !== 'one-line' && logger !== 'json-line' && typeof logger !== 'function') {
    throw new FluxionError(`Invalid logger option, Must be 'one-line', 'json-line' or a custom logger function`);
  }

  if (typeof rawDir !== 'string') {
    throw new FluxionError('FluxionOptions.dir must be a string');
  }
  // Ends with a separator, so "is this file under dir" is a plain `startsWith`
  const resolvedDir = path.resolve(process.cwd(), rawDir);
  const dir = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;

  if (typeof target !== 'string' && !(Array.isArray(target) && target.every((t) => typeof t === 'string'))) {
    throw new FluxionError('FluxionOptions.target must be a string or an array of strings');
  }

  if (typeof host !== 'string') {
    throw new FluxionError('FluxionOptions.host must be a string');
  }

  if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 100) {
    throw new FluxionError('FluxionOptions.handlerTimeoutMs must be an integer greater than 100');
  }

  if (!Number.isSafeInteger(middlewareTimeoutMs) || middlewareTimeoutMs <= 100) {
    throw new FluxionError('FluxionOptions.middlewareTimeoutMs must be an integer greater than 100');
  }

  if (typeof port !== 'number' || !Number.isSafeInteger(port)) {
    throw new FluxionError('FluxionOptions.port must be a positive integer');
  }

  if (port <= 1 || port > 65535) {
    throw new FluxionError('FluxionOptions.port must be 1 ~ 65535');
  }

  if (typeof maxRequestBytes !== 'number' || maxRequestBytes <= 0 || !Number.isSafeInteger(maxRequestBytes)) {
    throw new FluxionError('FluxionOptions.maxRequestBytes must be a positive integer');
  }

  if (csp !== false && typeof csp !== 'string') {
    throw new FluxionError('FluxionOptions.csp must be a string or false');
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    dir,
    host,
    port,
    handlerTimeoutMs,
    middlewareTimeoutMs,
    staticResourceTimeoutMs,
    target,
    maxRequestBytes,
    logger,
    apiInclude,
    staticInclude,
    exclude,
    https: normalizeHttpsOptions(https),
    csp,
    normalizedFlag: flags.OptionsNormalized,
  };
}
