import { DUMMY_BASE_URL } from '@/common/consts.js';

/** 把原始 req.url 解析成 URL；非法或缺省时返回 undefined。 */
export function toURL(rawUrl: string | undefined): URL | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }

  try {
    return new URL(rawUrl, DUMMY_BASE_URL);
  } catch {
    return undefined;
  }
}
