/**
 * 把查询参数折叠成 string | string[]：只出现一次保持字符串，重复出现则按首次出现顺序变成数组。
 */
export function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  return [...searchParams.entries()].reduce<Record<string, string | string[]>>((query, [key, value]) => {
    const existing = query[key];

    if (existing === undefined) {
      return { ...query, [key]: value };
    }
    if (Array.isArray(existing)) {
      return { ...query, [key]: [...existing, value] };
    }
    return { ...query, [key]: [existing, value] };
  }, {});
}
