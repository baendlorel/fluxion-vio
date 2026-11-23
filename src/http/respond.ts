import type { ServerResponse } from 'node:http';
import { HttpCode } from '@/common/consts.js';

/** 以 JSON 直接结束响应。 */
export function sendJson(res: ServerResponse, payload: unknown, statusCode: HttpCode = HttpCode.Ok): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/** 在响应尚未结束时写 JSON；已结束或已发出头时只做收尾。 */
export function safeSendJson(res: ServerResponse, payload: unknown, statusCode: HttpCode = HttpCode.Ok): void {
  // 已销毁的响应没有 socket 可写：客户端已断开，或控制器已停止。
  if (res.destroyed || res.writableEnded) {
    return;
  }

  if (res.headersSent) {
    res.end();
    return;
  }

  sendJson(res, payload, statusCode);
}
