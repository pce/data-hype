/**
 * src/interfaces/fetcher.ts
 *
 * Small Fetcher abstraction and helpers for Hype.
 *
 * Purpose:
 * - Provide a tiny, testable abstraction over `fetch` so consumers (Hype core,
 *   adapters, plugins) can inject auth/CSRF headers, retries, or alternative
 *   transport implementations without coupling to the global `fetch`.
 * - Keep the surface minimal: a `Fetcher` is just a function compatible with
 *   `window.fetch`.
 *
 * Recommended usage:
 *   const hype = createHype(config, {
 *     fetch: createFetcherWithHeaders(async () => ({ 'X-CSRF-Token': await getCsrfToken() }))
 *   });
 *
 *   // or for adapters:
 *   const adapter = new RestAdapter({ baseUrl: '/api/items', fetcher: hype.fetch });
 */

export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/**
 * HeadersProvider can be synchronous or asynchronous and should return a plain
 * object of header name -> value. It is intentionally small so callers can
 * implement CSRF token fetch, auth token lookups, or other dynamic header logic.
 */
export type HeadersProvider = () => Promise<Record<string, string>> | Record<string, string>;

/**
 * Default fetcher that delegates to the global `fetch`.
 * Consumers can override by providing a different Fetcher implementation.
 */
export const defaultFetcher: Fetcher = (input: RequestInfo, init?: RequestInit) => {
  // Delegate directly to global fetch; preserve passed init if any.
  return fetch(input, init);
};

/**
 * Normalize various HeadersInit shapes to a plain object with string values.
 */
function normalizeHeaders(h?: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) {
      out[k] = String(v);
    }
    return out;
  }
  // Record<string, string> case
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

/**
 * Merge two header objects into a HeadersInit object.
 * Order of precedence: `explicit` overrides `injected` (i.e. explicit headers
 * passed in RequestInit will take precedence over provider headers).
 */
function mergeHeaders(injected: Record<string, string>, explicit?: HeadersInit): Headers {
  const explicitObj = normalizeHeaders(explicit);
  const merged: Record<string, string> = { ...injected, ...explicitObj };
  const headers = new Headers();
  for (const [k, v] of Object.entries(merged)) headers.set(k, v);
  return headers;
}

/**
 * Create a Fetcher that injects headers from the provided `HeadersProvider`.
 *
 * - `headersProvider` can be sync or async and should return an object mapping
 *   header names to values (e.g. { 'Authorization': 'Bearer ...' }).
 * - `base` optionally supplies the underlying Fetcher to call (defaults to global fetch).
 *
 * Notes:
 * - The provider headers are merged with any headers from the supplied `init`.
 *   Explicit headers passed in `init` will override provider headers.
 */
export function createFetcherWithHeaders(headersProvider: HeadersProvider, base?: Fetcher): Fetcher {
  const underlying = base || defaultFetcher;
  return async (input: RequestInfo, init?: RequestInit) => {
    let provided: Record<string, string> = {};
    try {
      provided = (await headersProvider()) || {};
    } catch {
      provided = {};
    }
    const mergedHeaders = mergeHeaders(provided, init?.headers);
    const newInit: RequestInit = { ...(init || {}), headers: mergedHeaders };
    return underlying(input, newInit);
  };
}

/**
 * Convenience helper: perform a fetch and parse JSON safely.
 * - Resolves with parsed JSON on 2xx responses.
 * - Throws an Error containing `status` and `body` on non-OK responses.
 */
export async function fetchJson(fetcher: Fetcher, input: RequestInfo, init?: RequestInit): Promise<any> {
  const res = await fetcher(input, init);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  if (!res.ok) {
    let body: any = null;
    try {
      body = isJson ? await res.json() : await res.text();
    } catch (e) {
      body = `Failed to parse response body: ${String(e)}`;
    }
    const err: any = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (isJson) return res.json();
  return res.text();
}