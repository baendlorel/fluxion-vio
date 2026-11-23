import type http from 'node:http';
import type { FluxionLogger, InternalFluxionLogger, LoggerOption } from '@/common/logger.js';
import type { ModuleCache } from '@/common/loader.js';
import type { FluxionRouter } from './router/index.js';
import type { ModuleType } from './common/consts.js';

/** 任意字符串，用于放宽联合类型同时保留字面量提示。 */
export type otherstring = string & {};

export interface FluxionRequest {
  /** HTTP 请求方法（GET、POST、PUT、DELETE 等） */
  method: string;

  /** 客户端 IP（支持 X-Forwarded-For 与 X-Real-IP） */
  ip: string;

  /** 解析后的请求 URL */
  url: URL;

  /** 由 search string 解析出的查询参数 */
  query: Record<string, string | string[]>;

  /** 解析后的请求体（JSON、表单等） */
  body: Record<string, any>;

  /** 原始 HTTP 请求头 */
  headers: http.IncomingHttpHeaders;

  /** 从 Cookie 头解析出的 cookie */
  cookie: Record<string, string>;

  meta: Record<any, any>;
}

export interface FluxionOptions {
  /**
   * 动态文件（路由文件、上传文件等）所在目录，不存在时会创建。
   * 建议使用专用于此的目录，避免冲突或安全问题。
   */
  dir: string;

  host: string;

  port: number;

  /** 默认 5000ms。 */
  handlerTimeoutMs?: number;

  /** 每个中间件的执行超时，默认 3000ms。 */
  middlewareTimeoutMs?: number;

  /** 默认 3 分钟（3*60*1000ms）。 */
  staticResourceTimeoutMs?: number;

  /**
   * 编译 `dir` 下文件时使用的 esbuild target，如 'node20' 或 ['node20', 'es2022']。
   * 默认取运行中 Node.js 的主版本号，如 node24。
   */
  target?: string | string[];

  /** 动态 handler 可接受的请求体最大字节数，超出返回 413。 */
  maxRequestBytes?: number;

  /**
   * 日志输出模式或自定义 logger。
   * 默认 'json-line'：每行一个 JSON 对象，含 timestamp、level、event 字段。
   * 不内置单行模式——要人类可读格式请自己写 logger 函数。
   *
   * ! **注意** 框架同步调用日志函数且静默吞掉异常，请自行处理。
   */
  logger?: LoggerOption;

  /**
   * 把进程的 stdout 和 stderr 重定向到该文件，追加写入，父目录不存在会创建。
   *
   * 相对路径基于 process.cwd()。调用 fluxion() 之后进程打印的一切都进文件，
   * 包括 handler 里的 console.log；调用之前打印的仍去了终端。
   * @example './logs/server.log'
   */
  logOutputFile?: string;

  /**
   * 视为 API handler 的 glob 模式，命中者会被加载为 handler 并作为 API 提供。
   * 默认匹配全部 .ts 文件。
   * @example ['*.api.ts', 'handlers/*.js']
   */
  apiInclude?: string[];

  /**
   * 视为静态资源的 glob 模式：未命中 apiInclude 且命中此处的文件按静态资源提供。
   * 默认为全部文件。
   * @example ['*.html', '*.css', '*.js']
   */
  staticInclude?: string[];

  /**
   * 排除的 glob 模式：命中者永远不提供（既不是 API 也不是静态资源）。
   * 默认排除 node_modules、.git、dist 等常见目录。
   */
  exclude?: string[];

  /**
   * HTTPS 配置。提供后服务器改用 HTTPS；key 与 cert 必填，ca 可选（用于证书链）。
   * 相对路径基于 process.cwd()。
   */
  https?: {
    /** 私钥文件路径（PEM），或直接给出字符串/Buffer。 */
    key: string | Buffer;
    /** 证书文件路径（PEM），或直接给出字符串/Buffer。 */
    cert: string | Buffer;
    /** 可选：CA 证书文件路径或内容（字符串/Buffer/数组），用于中间证书。 */
    ca?: string | Buffer | Array<string | Buffer>;
  };

  /**
   * Content-Security-Policy 头的值，默认 "default-src 'self'"；设为 false 则完全不发该头。
   * @example "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' https:"
   */
  csp?: string | false;
}

export interface NormalizedFluxionOptions {
  /** 动态文件目录的绝对路径，始终以 path.sep 结尾。 */
  dir: string;
  host: string;
  port: number;
  handlerTimeoutMs: number;
  middlewareTimeoutMs: number;
  staticResourceTimeoutMs: number;
  target: string | string[];
  maxRequestBytes: number;
  logger: LoggerOption;
  logOutputFile?: string;
  apiInclude: string[];
  staticInclude: string[];
  exclude: string[];
  https?: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
  };

  /** CSP 头的值，或 false 表示不发送该头。 */
  csp: string | false;

  // ! 规范化标记，用于防止伪造已规范化的选项
  normalizedFlag: symbol;
}

export interface FluxionContext {
  options: NormalizedFluxionOptions;
  logger: InternalFluxionLogger;
  router: FluxionRouter;
  /** 从 dir 加载的模块，以绝对路径为键。归实例所有：同一进程内两次 fluxion() 不共享已加载代码。 */
  moduleCache: ModuleCache;
  /** 控制器停止时中止：在途的中间件和 handler 被放弃，响应被切断。 */
  signal: AbortSignal;
  /** 中止 {@link FluxionContext.signal}。内部使用：由控制器的 stop 调用一次。 */
  abort(): void;
}

/**
 * fluxion() 返回的句柄。信号处理由调用方负责：自行监听 SIGINT / SIGTERM 并在其中调用 {@link FluxionController.stop}。
 */
export interface FluxionController {
  /**
   * 强制结束所有在途请求：不再接受新连接，销毁现存 socket，
   * 仍在运行的 handler/中间件被放弃（不写响应）。同步且可重复调用。
   */
  stop(): void;
}

export interface FluxionModuleContext {
  logger: FluxionLogger;
}

export type FluxionHandler<
  Request extends typeof http.IncomingMessage = typeof http.IncomingMessage,
  Response extends typeof http.ServerResponse = typeof http.ServerResponse,
> = (
  request: FluxionRequest,
  cx: FluxionModuleContext,
  rawRequest: InstanceType<Request>,
  rawResponse: InstanceType<Response> & { req: InstanceType<Request> },
) => Promise<unknown> | unknown;

export type FluxionMiddleware<
  Request extends typeof http.IncomingMessage = typeof http.IncomingMessage,
  Response extends typeof http.ServerResponse = typeof http.ServerResponse,
> = (
  request: FluxionRequest,
  cx: FluxionModuleContext,
  rawRequest: InstanceType<Request>,
  rawResponse: InstanceType<Response>,
) => Promise<unknown> | unknown;

export type FluxionDisposer = () => Promise<void> | void;

/** FluxionModule 支持的 HTTP 方法 */
export type HTTPMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'
  | 'TRACE'
  | 'CONNECT'
  | otherstring;

export interface FluxionModule {
  /** API 的主处理函数 */
  handler: FluxionHandler;

  /**
   * 清理该模块实例创建的资源，在触发它的请求响应发出后执行一次。
   * 没有需要清理的东西时请省略。
   */
  disposer?: FluxionDisposer;

  /** 该模块 handler 的超时毫秒数 */
  handlerTimeoutMs?: number;

  /**
   * 允许的 HTTP 方法；指定后只接受这些方法。
   * @example ['GET', 'POST']
   */
  methods?: HTTPMethod[];

  /**
   * 这些函数会依次执行并被 await。
   *
   * **允许副作用：** 可以修改入参，后续中间件会看到修改后的版本。
   */
  middlewares?: FluxionMiddleware[];
}

export interface FluxionModuleObject extends FluxionModule {
  type: ModuleType;
}

export interface NormalizedModule extends FluxionModuleObject {
  absolutePath: string;

  /** 来自 fs.stat 的 mtime */
  mtimeMs: number;
}
