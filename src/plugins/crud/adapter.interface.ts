/**
 * CRUD adapter interface and simple REST adapter implementation
 *
 * Location: src/plugins/crud/adapter.interface.ts
 *
 * Purpose:
 * - Define a small, clear adapter interface that the CRUD plugin will use.
 * - Provide a minimal, well-documented REST adapter implementation suitable for
 *   immediate use or extension. The implementation uses a configurable Fetcher
 *   abstraction to avoid hardcoded global `fetch` usage.
 *
 * Notes:
 * - Keep this file focused on types and a small reference implementation.
 * - Adapters must be safe about JSON parsing and surface useful errors.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Fetcher } from "../../interfaces/fetcher";

export type ID = string | number;

export type ListParams = {
  page?: number;
  pageSize?: number;
  sort?: string; // e.g. "name,-createdAt"
  q?: string; // free text query
  filter?: Record<string, any>;
  [key: string]: any;
};

export type ListResult<T = any> = {
  items: T[];
  total?: number;
  page?: number;
  pageSize?: number;
  // optional raw meta for adapter-specific things (cursor, etc.)
  meta?: Record<string, any>;
};

export type DeleteResult = { ok: boolean; rowsAffected?: number };

export type CrudChangeEvent<T = any> =
  | { type: "create"; item: T }
  | { type: "update"; item: T }
  | { type: "delete"; id: ID }
  | { type: "patch"; id: ID; patch: Partial<T> };

/**
 * Optional function used by adapters to fetch auth headers or other dynamic headers.
 * It can be synchronous or async.
 */
export type HeadersProvider = () => Promise<Record<string, string>> | Record<string, string>;

/**
 * Core adapter interface that the CRUD plugin will call.
 *
 * Implementations MUST:
 *  - throw errors on non-2xx responses (or return rejected Promise) — the plugin
 *    will surface them as `crud:error`.
 *  - keep method semantics predictable and documented.
 */
export interface CrudAdapter<T = any> {
  list(params?: ListParams): Promise<ListResult<T>>;
  get(id: ID): Promise<T>;
  create(payload: Record<string, any>): Promise<T>;
  update(id: ID, payload: Record<string, any>): Promise<T>;
  delete(id: ID): Promise<DeleteResult>;

  /**
   * Optional: subscribe to live updates. Adapters that support push (SSE/WebSocket)
   * should implement this to notify the CRUD plugin of remote changes.
   *
   * Usage:
   *   const sub = adapter.subscribe({
   *     onChange(ev) { /* handle ev *\/ },
   *     onError(err) { /* optional error handling *\/ }
   *   });
   *   // sub.unsubscribe() to stop.
   */
  subscribe?: (opts: { onChange: (ev: CrudChangeEvent<T>) => void; onError?: (err: any) => void }) => { unsubscribe(): void };

  /**
   * Optional: expose schema (OpenAPI/JSON Schema) for resource to enable
   * form scaffolding and client-side validation.
   */
  getSchema?: (resource?: string) => Promise<any>;
}

/* -------------------------------------------------------------------------- */
/* Rest adapter implementation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * RestAdapterOptions
 * - baseUrl: base endpoint (e.g. /api/items)
 * - pk: primary key field name used by adapter when needed (default: 'id')
 * - headersProvider: optional function to supply dynamic headers (auth/csrf)
 * - defaultPageSize: fallback page size
 * - fetcher: optional Fetcher abstraction to use for HTTP calls (overrides global fetch)
 */
export type RestAdapterOptions = {
  baseUrl: string;
  pk?: string;
  headersProvider?: HeadersProvider;
  defaultPageSize?: number;
  fetcher?: Fetcher;
  /**
   * If true, the adapter will append `page` and `pageSize` as query params for lists.
   */
  paginationAsQuery?: boolean;
};

/**
 * Helper: build query string from ListParams. Simple flattening rule:
 * - filter and other nested objects will be JSON-stringified (safe fallback)
 */
function buildQuery(params?: ListParams): string {
  if (!params) return "";
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      try {
        qp.append(k, JSON.stringify(v));
      } catch {
        qp.append(k, String(v));
      }
    } else if (Array.isArray(v)) {
      for (const it of v) qp.append(k, String(it));
    } else {
      qp.append(k, String(v));
    }
  }
  const s = qp.toString();
  return s ? `?${s}` : "";
}

/**
 * A minimal REST adapter. Intentionally conservative:
 * - Assumes JSON request/response.
 * - Throws on non-OK responses with a small wrapper error object.
 *
 * Example:
 *   const a = new RestAdapter({ baseUrl: '/api/items', headersProvider: () => ({ 'X-CSRF-Token': '...' }) });
 *   await a.list({ page: 1, pageSize: 20 });
 */
export class RestAdapter<T = any> implements CrudAdapter<T> {
  public baseUrl: string;
  public pk: string;
  private headersProvider?: HeadersProvider;
  private defaultPageSize: number;
  private paginationAsQuery: boolean;
  private fetcher?: Fetcher;

  constructor(opts: RestAdapterOptions) {
    if (!opts || !opts.baseUrl) {
      throw new Error("RestAdapter requires a baseUrl in options");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ""); // normalize trailing slash
    this.pk = opts.pk || "id";
    this.headersProvider = opts.headersProvider;
    this.defaultPageSize = opts.defaultPageSize ?? 20;
    this.paginationAsQuery = opts.paginationAsQuery ?? true;
    // Use provided fetcher or fall back to global fetch at call time.
    this.fetcher = opts.fetcher;
  }

  protected async getHeaders(): Promise<Record<string, string>> {
    const base: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    if (!this.headersProvider) return base;
    try {
      const dyn = await Promise.resolve(this.headersProvider());
      return { ...base, ...dyn };
    } catch {
      return base;
    }
  }

  protected async handleResponse(res: Response) {
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const isJson = contentType.includes("application/json");
    if (!res.ok) {
      let body: any = null;
      try {
        body = isJson ? await res.json() : await res.text();
      } catch (e) {
        body = `Failed to parse response: ${String(e)}`;
      }
      const err: any = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (isJson) return res.json();
    return res.text();
  }

  /**
   * List
   */
  public async list(params?: ListParams): Promise<ListResult<T>> {
    // Build a safe params object so we can inject defaultPageSize when paginationAsQuery is enabled.
    let safeParams: ListParams | undefined = params ? { ...params } : undefined;
    if (this.paginationAsQuery) {
      if (!safeParams) {
        safeParams = { pageSize: this.defaultPageSize } as ListParams;
      } else if (safeParams.pageSize === undefined || safeParams.pageSize === null) {
        safeParams.pageSize = this.defaultPageSize;
      }
    }

    const qp = this.paginationAsQuery ? buildQuery(safeParams) : "";
    const url = `${this.baseUrl}${qp}`;
    const headers = await this.getHeaders();
    const res = await (this.fetcher ? this.fetcher(url, { method: "GET", headers, credentials: "same-origin" }) : fetch(url, { method: "GET", headers, credentials: "same-origin" }));
    const parsed = await this.handleResponse(res);
    // Expecting shape: { items: [...], total?, page?, pageSize? } OR an array (legacy)
    if (Array.isArray(parsed)) {
      return { items: parsed };
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).items)) {
      return parsed as ListResult<T>;
    }
    // Fallback: try to coerce
    return { items: (parsed && (parsed as any).items) || [] };
  }

  /**
   * Get single
   */
  public async get(id: ID): Promise<T> {
    const headers = await this.getHeaders();
    const url = `${this.baseUrl}/${encodeURIComponent(String(id))}`;
    const res = await (this.fetcher ? this.fetcher(url, { method: "GET", headers, credentials: "same-origin" }) : fetch(url, { method: "GET", headers, credentials: "same-origin" }));
    return this.handleResponse(res);
  }

  /**
   * Create
   */
  public async create(payload: Record<string, any>): Promise<T> {
    const headers = await this.getHeaders();
    const url = this.baseUrl;
    const res = await (this.fetcher ? this.fetcher(url, { method: "POST", headers, body: JSON.stringify(payload), credentials: "same-origin" }) : fetch(url, { method: "POST", headers, body: JSON.stringify(payload), credentials: "same-origin" }));
    return this.handleResponse(res);
  }

  /**
   * Update (PUT by default)
   */
  public async update(id: ID, payload: Record<string, any>): Promise<T> {
    const headers = await this.getHeaders();
    const url = `${this.baseUrl}/${encodeURIComponent(String(id))}`;
    const res = await (this.fetcher ? this.fetcher(url, { method: "PUT", headers, body: JSON.stringify(payload), credentials: "same-origin" }) : fetch(url, { method: "PUT", headers, body: JSON.stringify(payload), credentials: "same-origin" }));
    return this.handleResponse(res);
  }

  /**
   * Delete
   */
  public async delete(id: ID): Promise<DeleteResult> {
    const headers = await this.getHeaders();
    const url = `${this.baseUrl}/${encodeURIComponent(String(id))}`;
    const res = await (this.fetcher ? this.fetcher(url, { method: "DELETE", headers, credentials: "same-origin" }) : fetch(url, { method: "DELETE", headers, credentials: "same-origin" }));
    const parsed = await this.handleResponse(res);
    // Accept { ok: true } or empty body -> success
    if (parsed === "" || parsed == null) return { ok: true };
    if (typeof parsed === "object" && typeof (parsed as any).ok !== "undefined") return parsed as DeleteResult;
    return { ok: true };
  }

  /**
   * Default RestAdapter doesn't provide a push/subscribe implementation.
   * Adapters that support SSE/WS should implement `subscribe`.
   */
  public subscribe?(_: { onChange: (ev: CrudChangeEvent<T>) => void; onError?: (err: any) => void }) {
    // noop by default — adapters that support live updates should override
    return { unsubscribe() {} };
  }
}

export default RestAdapter;
