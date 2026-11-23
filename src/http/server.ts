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

const waiter = (mainPromise: Promise<any>, timeoutMs: number, flag: symbol) =>
  Promise.race([mainPromise, new Promise((r) => setTimeout(() => r(flag), timeoutMs))]);

/**
 * Run a module's disposer once the response has been sent.
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

/** Run the middleware chain. Returns `true` when a middleware already produced the response. */
async function runMiddlewares(
  cx: FluxionContext,
  moduleCx: FluxionModuleContext,
  m: NormalizedModule,
  request: FluxionRequest,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  for (const middleware of m.middlewares ?? []) {
    const result = await waiter(
      PromiseTry(middleware, request, moduleCx, req, res),
      cx.options.middlewareTimeoutMs,
      flags.MiddlewareTimeout,
    );

    if (result === flags.MiddlewareTimeout) {
      cx.logger.warn({ event: 'MiddlewareTimeout', method: request.method, ip: request.ip });
      safeSendJson(res, { message: 'Internal Server Error' }, HttpCode.InternalServerError);
      return true;
    }
    if (res.writableEnded) {
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
  const timeoutMs =
    m.type === ModuleType.Api
      ? (m.handlerTimeoutMs ?? cx.options.handlerTimeoutMs)
      : cx.options.staticResourceTimeoutMs;

  const result = await waiter(
    PromiseTry(m.handler, request, moduleCx, req, res),
    timeoutMs,
    flags.HandlerTimeout,
  );

  if (result === flags.HandlerTimeout) {
    cx.logger.warn({ event: 'HandlerTimeout', method: request.method, ip: request.ip });
    safeSendJson(res, { message: 'Handler timed out' }, HttpCode.InternalServerError);
    return;
  }

  if (result !== flags.StaticHandled) {
    safeSendJson(res, result);
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

export function createServer(cx: FluxionContext): Promise<http.Server | https.Server> {
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
