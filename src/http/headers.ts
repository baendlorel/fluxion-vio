import type { IncomingMessage } from 'node:http';

/** 取真实客户端 IP，依次尝试 X-Forwarded-For、X-Real-IP、socket 地址。 */
export function getRealIp(req: IncomingMessage): string {
  const forwardedFor = req.headersDistinct['x-forwarded-for'];
  if (forwardedFor) {
    const firstForwarded = forwardedFor[0]?.split(',')[0]?.trim();
    if (firstForwarded && firstForwarded.length > 0) {
      return firstForwarded;
    }
  }

  const realIp = req.headersDistinct['x-real-ip']?.[0].trim();
  if (realIp !== undefined) {
    return realIp;
  }

  return req.socket.remoteAddress ?? 'unknown';
}

/** 判断 Content-Type 是否属于可当文本处理的类型。 */
export function isTextualContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }

  const normalized = contentType.toLowerCase();

  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('x-www-form-urlencoded') ||
    normalized.includes('javascript')
  );
}
