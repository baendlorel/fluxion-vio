/**
 * Fold the parameters into an object of `string | string[]`: a key seen once stays a string, a repeated key
 * becomes an array in first-seen order.
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
