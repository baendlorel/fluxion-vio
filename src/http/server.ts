import http from 'node:http';
import https from 'node:https';

import type { FluxionContext, FluxionModuleContext, FluxionRequest, NormalizedModule } from '../types.js';
import { HttpCode, flags, ModuleType } from '@/common/consts.js';
import { PromiseTry } from '@/common/promise-try.js';
import { formatError } from '@/common/logger.js';

import { getRealIp } from './headers.js';
import { toURL } from './request.js';
import { safeSendJson } from './respond.js';
import { parseBody, type BodyPreview } from './body.js';
import { parseQuery } from './query.js';
import { parseCookie } from './cookie.js';
import { HttpException } from './exceptions.js';

/**
 * How a piece of middleware or handler work ended.
 * - `value`: it settled, and this is what it returned or threw;
 * - `timeout`: its own timeout fired first;
 * - `stopped`: the controller's abort signal fired first, so the response is already gone.
 */
type Outcome = { kind: 'value'; value: unknown } | { kind: 'timeout' } | { kind: 'stopped' };

/**
 * Race a piece of handler work against a timeout and the controller's abort signal.
 *
 * The work promise always gets a rejection handler. A failure that loses the race is no longer returned to
 * the request path (its socket is gone), so it is logged here; one that wins is re-thrown and reported by the
 * request path exactly like any other failure.
 */
async function raceWork(
  cx: FluxionContext,
  work: Promise<unknown>,
  timeoutMs: number,
  m: NormalizedModule,
): Promise<Outcome> {
  // Marked from inside the losing sides of the race, before they resolve, so the flag is already set when a
  // late rejection arrives on the microtask queue.
  const abandoned = { current: false };

  work.catch((e: unknown) => {
    if (abandoned.current) {
      cx.logger.error({ event: 'HandlerFailedAfterAbandon', url: m.absolutePath, error: formatError(e) });
    }
  });

  // Already stopping: do not start new work's timeout window, just report it.
  if (cx.signal.aborted) {
    return { kind: 'stopped' };
  }

  return Promise.race([
    work.then((value): Outcome => ({ kind: 'value', value })),
    new Promise<Outcome>((resolve) =>
      setTimeout(() => {
        abandoned.current = true;
        resolve({ kind: 'timeout' });
      }, timeoutMs),
    ),
    new Promise<Outcome>((resolve) =>
      cx.signal.addEventListener(
        'abort',
        () => {
          abandoned.current = true;
          resolve({ kind: 'stopped' });
        },
        { once: true },
      ),
    ),
  ]);
}

/**
 * The timeout that applies to a piece of work, derived from the phase it runs in.
 * Middlewares have their own budget; API handlers may override the instance default; static resources use the
 * (much longer) static budget.
 */
const timeoutFor = (cx: FluxionContext, m: NormalizedModule, phase: Phase): number => {
  if (phase === 'middleware') {
    return cx.options.middlewareTimeoutMs;
  }
  return m.type === ModuleType.Api
    ? (m.handlerTimeoutMs ?? cx.options.handlerTimeoutMs)
    : cx.options.staticResourceTimeoutMs;
};

/** Which part of a module is running, so the timeout rule can be picked without the caller knowing it. */
type Phase = 'middleware' | 'handler';

/** Run a piece of middleware or handler work with the timeout its phase implies. */
const runPhase = (cx: FluxionContext, m: NormalizedModule, phase: Phase, work: Promise<unknown>): Promise<Outcome> =>
  raceWork(cx, work, timeoutFor(cx, m, phase), m);

/** Run a module's disposer once the response has been sent.
 * Modules without a disposer are left untouched.
 */
function disposeAfterResponse(cx: FluxionContext, res: http.ServerResponse, m: NormalizedModule) {
  // The module instance is shared by requests while its files are unchanged: the disposer runs once per response.
  if (typeof m.disposer !== 'function') {
    return;
  }
  const disposer = m.disposer;
  res.once('close', () => {
    PromiseTry(disposer).catch((e: unknown) => {
      cx.logger.error({ event: 'DisposerFailed', url: m.absolutePath, error: formatError(e) });
    });
  });
}

/** Build the request object handlers see. Pure: every field is derived from `req` and `url`. */
function toFluxionRequest(req: http.IncomingMessage, url: URL): FluxionRequest {
  return {
    method: req.method ?? 'GET',
    ip: getRealIp(req),
    url,
    query: parseQuery(url.searchParams),
    body: {},
    headers: req.headers,
    cookie: parseCookie(req.headers.cookie as string | undefined),
    meta: {},
  };
}

/** Security headers applied to every response. */
function applySecurityHeaders(res: http.ServerResponse, csp: string | false): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Content-Security-Policy (user-configurable, header omitted when set to false)
  if (csp !== false) {
    res.setHeader('Content-Security-Policy', csp);
  }
}

/**
 * Log the response once it has been sent. The request snapshot is passed in rather than read back, so the
 * callback does not depend on later mutation of `normalized`.
 */
function logResponse(
  cx: FluxionContext,
  res: http.ServerResponse,
  request: FluxionRequest,
  bodyPreview: BodyPreview,
  start: number,
): void {
  const o: Record<string, unknown> = {
    event: 'response',
    method: request.method,
    ip: request.ip,
    path: request.url.pathname,
    status: res.statusCode,
    duration: (performance.now() - start).toFixed(4),
  };

  if (Object.keys(request.query).length > 0) {
    o.query = request.query;
  }

  if (bodyPreview.exists) {
    o.body = bodyPreview.value;
    o.bodyBytes = bodyPreview.bytes;
    o.bodyTruncated = bodyPreview.truncated;
  }

  cx.logger.core(o);
}

/** Run the middleware chain. Returns `true` when a middleware already produced the response or stopped it. */
async function runMiddlewares(
  cx: FluxionContext,
  moduleCx: FluxionModuleContext,
  m: NormalizedModule,
  request: FluxionRequest,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  for (const middleware of m.middlewares ?? []) {
    const outcome = await runPhase(cx, m, 'middleware', PromiseTry(middleware, request, moduleCx, req, res));

    if (outcome.kind === 'stopped') {
      return true;
    }
    if (outcome.kind === 'timeout') {
      cx.logger.warn({ event: 'MiddlewareTimeout', method: request.method, ip: request.ip });
      safeSendJson(res, { message: 'Internal Server Error' }, HttpCode.InternalServerError);
      return true;
    }
    if (res.writableEnded || res.destroyed) {
      return true;
    }
    if (res.headersSent) {
      res.end();
      return true;
    }
  }
  return false;
}

/** Run the handler and write its result to the response. */
async function runHandler(
  cx: FluxionContext,
  moduleCx: FluxionModuleContext,
  m: NormalizedModule,
  request: FluxionRequest,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const outcome = await runPhase(cx, m, 'handler', PromiseTry(m.handler, request, moduleCx, req, res));

  if (outcome.kind === 'stopped') {
    return;
  }
  if (outcome.kind === 'timeout') {
    cx.logger.warn({ event: 'HandlerTimeout', method: request.method, ip: request.ip });
    safeSendJson(res, { message: 'Handler timed out' }, HttpCode.InternalServerError);
    return;
  }

  if (outcome.value !== flags.StaticHandled) {
    safeSendJson(res, outcome.value);
  }
}

/** Turn a thrown value into a response, without leaking internals. */
function reportFailure(cx: FluxionContext, res: http.ServerResponse, request: FluxionRequest, e: unknown): void {
  if (e instanceof HttpException) {
    cx.logger.error({ ...request, event: 'RequestFailed', error: e.message });
    safeSendJson(res, { message: e.message }, e.errno);
    return;
  }
  cx.logger.error({ ...request, event: 'RequestFailed', error: formatError(e) });
  safeSendJson(res, { message: 'Internal Server Error' }, HttpCode.InternalServerError);
}

/** The full lifecycle of one request. */
async function handleRequest(
  cx: FluxionContext,
  moduleCx: FluxionModuleContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = toURL(req.url);
  if (url === undefined) {
    safeSendJson(res, { message: 'Bad Request: req.url is undefined' }, HttpCode.BadRequest);
    return;
  }

  applySecurityHeaders(res, cx.options.csp);

  const start = performance.now();
  // Re-bound once the body is parsed. The request object itself is never mutated: handlers get a finished value.
  let request = toFluxionRequest(req, url);
  let bodyPreview: BodyPreview = { exists: false, bytes: 0, truncated: false };
  res.once('finish', () => logResponse(cx, res, request, bodyPreview, start));

  cx.logger.core({ event: 'request', method: request.method, ip: request.ip, path: url.pathname });

  try {
    const parsed = await parseBody(req, request.method, cx.options.maxRequestBytes);
    request = { ...request, body: parsed.body };
    bodyPreview = parsed.preview;

    // A stop may land while the body was being read.
    if (cx.signal.aborted) {
      return;
    }

    const m = await cx.router(url);
    if (!m) {
      safeSendJson(res, { message: 'Not Found' }, HttpCode.NotFound);
      return;
    }

    if (m.methods && !m.methods.includes(request.method)) {
      safeSendJson(res, { message: 'Method Not Allowed' }, HttpCode.MethodNotAllowed);
      return;
    }

    // Clean up this request's module instance after the response is sent.
    disposeAfterResponse(cx, res, m);

    if (await runMiddlewares(cx, moduleCx, m, request, req, res)) {
      return;
    }
    await runHandler(cx, moduleCx, m, request, req, res);
  } catch (e) {
    reportFailure(cx, res, request, e);
  }
}

/**
 * The parts of `http.Server` / `https.Server` the controller needs. Both provide them, but `https.Server`
 * does not extend `http.Server`.
 */
export interface ListeningServer {
  close(cb?: (err?: Error) => void): unknown;
  closeAllConnections(): void;
}

export function createServer(cx: FluxionContext): Promise<ListeningServer> {
  const moduleCx: FluxionModuleContext = Object.freeze({ logger: cx.logger });
  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) =>
    handleRequest(cx, moduleCx, req, res);

  const server = cx.options.https
    ? https.createServer(
        {
          key: cx.options.https.key,
          cert: cx.options.https.cert,
          ca: cx.options.https.ca,
        },
        requestHandler,
      )
    : http.createServer(requestHandler);

  return new Promise((resolve, reject) => {
    let listening = false;

    server.on('close', () => {
      cx.logger.core({
        event: 'ServerClosed',
        host: cx.options.host,
        port: cx.options.port,
      });
    });

    server.once('listening', () => {
      listening = true;
      cx.logger.core({
        event: 'FluxionStarted',
        version: '__VERSION__',
        pid: process.pid,
        protocol: cx.options.https ? 'https' : 'http',
        host: cx.options.host,
        port: cx.options.port,
      });
      cx.logger.core({
        event: 'DynamicDirectory',
        directory: cx.options.dir,
      });
      resolve(server);
    });

    server.on('error', (e) => {
      cx.logger.error({
        event: 'ServerError',
        error: formatError(e),
      });
      if (listening) {
        // Server encountered an error after binding — log and let the
        // caller (PM2 / user code) decide how to recover instead of
        // forcing process.exit(1) here.
        return;
      }
      reject(e);
    });

    server.listen(cx.options.port, cx.options.host);
  });
}
