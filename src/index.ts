import { fluxion } from './fluxion.js';
import { HttpCode } from './common/consts.js';

export { fluxion, HttpCode };

/** 导出 fluxion 版本号，便于调试。@version __VERSION__ */
export const VERSION = '__VERSION__';

// 导出全部 HTTP 异常
export {
  HttpException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  MethodNotAllowedException,
  NotAcceptableException,
  RequestTimeoutException,
  ConflictException,
  GoneException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  UnprocessableEntityException,
  TooManyRequestsException,
  InternalServerErrorException,
  NotImplementedException,
  BadGatewayException,
  ServiceUnavailableException,
  GatewayTimeoutException,
} from './http/exceptions.js';

export * from './defines/index.js';

export type {
  FluxionRequest,
  FluxionModuleContext,
  FluxionDisposer,
  FluxionHandler,
  FluxionModule,
  FluxionOptions,
  FluxionController,
} from './types.js';

export type { FluxionLogger, LogEntry, LogPayload, FluxionLoggerFn, LoggerOption } from './common/logger.js';
