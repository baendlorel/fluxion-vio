const MAX_COOKIE_KEYS = 100;

/** A cookie value that is not valid percent-encoding is kept verbatim instead of failing the request. */
const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Parse Cookie header string into an object
 */
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

/**
 * Serialize an object into a Cookie header string
 */
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
