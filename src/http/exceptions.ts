import { HttpCode } from '@/common/consts.js';

const FLUXION_HTTP_EXCEPTION = Symbol.for('FLUXION_HTTP_EXCEPTION');

/**
 * 所有 HTTP 异常的基类。
 *
 * 动态文件会被编译成 CJS，因此它 require 到的是本包的 CJS 构建，而框架自身可能运行在 ESM 构建里——
 * 两边的 class 是不同的对象，instanceof 会失效。这里改用全局唯一标记做判定，跨越模块实例。
 */
export abstract class HttpException extends Error implements NodeJS.ErrnoException {
  /** 标记为 HTTP 异常，instanceof 失效时靠它识别。 */
  readonly [FLUXION_HTTP_EXCEPTION] = true;

  errno?: number | undefined;
  code?: string | undefined;

  constructor(message: string, statusCode: HttpCode, code: string) {
    super(message);
    this.name = 'HttpException';
    this.errno = statusCode;
    this.code = code;
  }
}

/** 判断一个值是否为 HTTP 异常；不依赖 instanceof，跨 ESM/CJS 构建也能识别。 */
export function isHttpException(e: unknown): e is HttpException {
  return typeof e === 'object' && e !== null && FLUXION_HTTP_EXCEPTION in e;
}

// 4xx 客户端错误

/**
 * 400 请求格式错误或非法
 */
export class BadRequestException extends HttpException {
  constructor(message: string = 'Bad Request') {
    super(message, HttpCode.BadRequest, 'BAD_REQUEST');
  }
}

/**
 * 401 需要认证或认证失败
 */
export class UnauthorizedException extends HttpException {
  constructor(message: string = 'Unauthorized') {
    super(message, HttpCode.Unauthorized, 'UNAUTHORIZED');
  }
}

/**
 * 403 请求合法但未获授权
 */
export class ForbiddenException extends HttpException {
  constructor(message: string = 'Forbidden') {
    super(message, HttpCode.Forbidden, 'FORBIDDEN');
  }
}

/**
 * 404 资源不存在
 */
export class NotFoundException extends HttpException {
  constructor(message: string = 'Not Found') {
    super(message, HttpCode.NotFound, 'NOT_FOUND');
  }
}

/**
 * 405 该资源不支持此 HTTP 方法
 */
export class MethodNotAllowedException extends HttpException {
  constructor(message: string = 'Method Not Allowed') {
    super(message, HttpCode.MethodNotAllowed, 'METHOD_NOT_ALLOWED');
  }
}

/**
 * 406 无法生成可接受的响应
 */
export class NotAcceptableException extends HttpException {
  constructor(message: string = 'Not Acceptable') {
    super(message, HttpCode.NotAcceptable, 'NOT_ACCEPTABLE');
  }
}

/**
 * 408 客户端未在规定时间内完成请求
 */
export class RequestTimeoutException extends HttpException {
  constructor(message: string = 'Request Timeout') {
    super(message, HttpCode.RequestTimeout, 'REQUEST_TIMEOUT');
  }
}

/**
 * 409 请求与当前状态冲突
 */
export class ConflictException extends HttpException {
  constructor(message: string = 'Conflict') {
    super(message, HttpCode.Conflict, 'CONFLICT');
  }
}

/**
 * 410 资源已不再可用
 */
export class GoneException extends HttpException {
  constructor(message: string = 'Gone') {
    super(message, HttpCode.Gone, 'GONE');
  }
}

/**
 * 413 请求实体超过大小限制
 */
export class PayloadTooLargeException extends HttpException {
  constructor(message: string = 'Payload Too Large') {
    super(message, HttpCode.PayloadTooLarge, 'PAYLOAD_TOO_LARGE');
  }
}

/**
 * 415 不支持的请求格式
 */
export class UnsupportedMediaTypeException extends HttpException {
  constructor(message: string = 'Unsupported Media Type') {
    super(message, HttpCode.UnsupportedMediaType, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

/**
 * 422 语法正确但语义错误
 */
export class UnprocessableEntityException extends HttpException {
  constructor(message: string = 'Unprocessable Entity') {
    super(message, HttpCode.UnprocessableEntity, 'UNPROCESSABLE_ENTITY');
  }
}

/**
 * 429 超出频率限制
 */
export class TooManyRequestsException extends HttpException {
  constructor(message: string = 'Too Many Requests') {
    super(message, HttpCode.TooManyRequests, 'TOO_MANY_REQUESTS');
  }
}

// 5xx 服务端错误

/**
 * 500 服务器出现意外状况
 */
export class InternalServerErrorException extends HttpException {
  constructor(message: string = 'Internal Server Error') {
    super(message, HttpCode.InternalServerError, 'INTERNAL_SERVER_ERROR');
  }
}

/**
 * 501 服务器不支持该功能
 */
export class NotImplementedException extends HttpException {
  constructor(message: string = 'Not Implemented') {
    super(message, HttpCode.NotImplemented, 'NOT_IMPLEMENTED');
  }
}

/**
 * 502 上游服务器返回了无效响应
 */
export class BadGatewayException extends HttpException {
  constructor(message: string = 'Bad Gateway') {
    super(message, HttpCode.BadGateway, 'BAD_GATEWAY');
  }
}

/**
 * 503 服务暂时不可用
 */
export class ServiceUnavailableException extends HttpException {
  constructor(message: string = 'Service Unavailable') {
    super(message, HttpCode.ServiceUnavailable, 'SERVICE_UNAVAILABLE');
  }
}

/**
 * 504 上游服务器超时
 */
export class GatewayTimeoutException extends HttpException {
  constructor(message: string = 'Gateway Timeout') {
    super(message, HttpCode.GatewayTimeout, 'GATEWAY_TIMEOUT');
  }
}
