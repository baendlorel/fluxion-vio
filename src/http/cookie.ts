/** 单次请求最多解析的 cookie 数，防止超长 Cookie 头。 */
const MAX_COOKIE_KEYS = 100;

/** 非法的百分号编码不再让整个请求失败，而是原样保留。 */
const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** 把 Cookie 头解析成对象。 */
export function parseCookie(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .filter((pair) => pair.trim().length > 0)
    .slice(0, MAX_COOKIE_KEYS)
    .reduce<Record<string, string>>((cookies, pair) => {
      const [key, ...valueParts] = pair.split('=');
      const trimmedKey = key?.trim();
      if (!trimmedKey) {
        return cookies;
      }
      return { ...cookies, [trimmedKey]: decode(valueParts.join('=').trim()) };
    }, {});
}

/** 把名称、值和选项序列化成一条 Set-Cookie 字符串。 */
export function serializeCookie(
  name: string,
  value: string,
  options?: {
    maxAge?: number;
    expires?: Date;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
  },
): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (options) {
    if (options.maxAge !== undefined) {
      cookie += `; Max-Age=${options.maxAge}`;
    }
    if (options.expires) {
      cookie += `; Expires=${options.expires.toUTCString()}`;
    }
    if (options.domain) {
      cookie += `; Domain=${options.domain}`;
    }
    if (options.path) {
      cookie += `; Path=${options.path}`;
    }
    if (options.secure) {
      cookie += '; Secure';
    }
    if (options.httpOnly) {
      cookie += '; HttpOnly';
    }
    if (options.sameSite) {
      cookie += `; SameSite=${options.sameSite}`;
    }
  }

  return cookie;
}
