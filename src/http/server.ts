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
 * 一段中间件/handler 工作的结局：
 * - value：正常结束，附带返回值；
 * - timeout：它自己的超时先到；
 * - stopped：控制器的中止信号先到，响应已经不存在了。
 */
type Outcome = { kind: 'value'; value: unknown } | { kind: 'timeout' } | { kind: 'stopped' };

/** 正在执行的是模块的哪一部分，用来决定超时规则。 */
type Phase = 'middleware' | 'handler';

/**
 * 让一段 handler 工作和超时、中止信号赛跑。
 *
 * 永远给 work 挂上 catch：输掉赛跑的异常不会再回到请求路径（socket 已断），只能在这里记日志；
 * 赢了的异常会照常抛出，由请求路径统一上报。
 */
async function raceWork(
  cx: FluxionContext,
  work: Promise<unknown>,
  timeoutMs: number,
  m: NormalizedModule,
): Promise<Outcome> {
  // 由输掉赛跑的那一方在 resolve 之前置位，这样迟到的 rejection 进微任务时标记已经打好。
  const abandoned = { current: false };

  work.catch((e: unknown) => {
    if (abandoned.current) {
      cx.logger.error({ event: 'HandlerFailedAfterAbandon', url: m.absolutePath, error: formatError(e) });
    }
  });

  // 已经在停止中：不再开新的超时窗口，直接报告。
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
 * 按阶段取超时：中间件有自己的预算；API handler 可覆盖实例默认值；静态资源用更长的静态预算。
 */
const timeoutFor = (cx: FluxionContext, m: NormalizedModule, phase: Phase): number => {
  if (phase === 'middleware') {
    return cx.options.middlewareTimeoutMs;
  }
  return m.type === ModuleType.Api
    ? (m.handlerTimeoutMs ?? cx.options.handlerTimeoutMs)
    : cx.options.staticResourceTimeoutMs;
};

/** 按阶段带超时地执行一段中间件或 handler 工作。 */
const runPhase = (cx: FluxionContext, m: NormalizedModule, phase: Phase, work: Promise<unknown>): Promise<Outcome> =>
  raceWork(cx, work, timeoutFor(cx, m, phase), m);

/** 响应发出后执行模块的 disposer；没有 disposer 的直接跳过。 */
function disposeAfterResponse(cx: FluxionContext, res: http.ServerResponse, m: NormalizedModule) {
  // 文件未变时模块实例被多个请求共享：每个响应各执行一次 disposer。
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

/** 构造交给 handler 的请求对象。纯函数：每个字段都由 req 和 url 推导。 */
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

/** 给所有响应加安全头。 */
function applySecurityHeaders(res: http.ServerResponse, csp: string | false): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // CSP 由选项控制，设为 false 时整条头都不发
  if (csp !== false) {
    res.setHeader('Content-Security-Policy', csp);
  }
}

/** 响应发出后记一条日志。请求快照是传进来的，回调不依赖后续对它的修改。 */
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

/** 依次执行中间件。返回 true 表示响应已经产生（或请求已被中止）。 */
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

/** 执行 handler，并把返回值写进响应。 */
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

/** 把抛出的值转成响应，且不泄漏内部细节。 */
function reportFailure(cx: FluxionContext, res: http.ServerResponse, request: FluxionRequest, e: unknown): void {
  if (e instanceof HttpException) {
    cx.logger.error({ ...request, event: 'RequestFailed', error: e.message });
    safeSendJson(res, { message: e.message }, e.errno);
    return;
  }
  cx.logger.error({ ...request, event: 'RequestFailed', error: formatError(e) });
  safeSendJson(res, { message: 'Internal Server Error' }, HttpCode.InternalServerError);
}

/** 单个请求的完整生命周期。 */
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
  // body 解析完成后重新绑定；请求对象本身不会被原地修改，handler 拿到的永远是完整值。
  let request = toFluxionRequest(req, url);
  let bodyPreview: BodyPreview = { exists: false, bytes: 0, truncated: false };
  res.once('finish', () => logResponse(cx, res, request, bodyPreview, start));

  cx.logger.core({ event: 'request', method: request.method, ip: request.ip, path: url.pathname });

  try {
    const parsed = await parseBody(req, request.method, cx.options.maxRequestBytes);
    request = { ...request, body: parsed.body };
    bodyPreview = parsed.preview;

    // 读取 body 期间可能已经被 stop。
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

    // 响应发出后清理本次请求的模块实例。
    disposeAfterResponse(cx, res, m);

    if (await runMiddlewares(cx, moduleCx, m, request, req, res)) {
      return;
    }
    await runHandler(cx, moduleCx, m, request, req, res);
  } catch (e) {
    reportFailure(cx, res, request, e);
  }
}

/** 控制器需要的 http.Server / https.Server 公共部分；后者并不继承前者。 */
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
        // 绑定成功之后的错误只记录，交给上层（PM2 / 用户代码）决定如何恢复，不强制 exit。
        return;
      }
      reject(e);
    });

    server.listen(cx.options.port, cx.options.host);
  });
}
