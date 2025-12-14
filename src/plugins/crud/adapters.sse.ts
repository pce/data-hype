/**
 * src/plugins/crud/adapters.sse.ts
 *
 * SSE (Server-Sent Events) adapter implementing the CrudAdapter interface.
 *
 * - Provides standard CRUD methods via REST fetch calls (JSON) against `baseUrl`.
 * - Provides `subscribe({ onChange, onError })` which opens an EventSource to `sseUrl`
 *   (or `${baseUrl}/sse` by convention) and forwards parsed messages as `CrudChangeEvent`.
 * - Reconnects with a simple exponential backoff on connection errors (configurable).
 *
 * Requirements:
 *  - Server SSE messages must send valid JSON in `event.data`, with a shape similar to:
 *      { type: 'create'|'update'|'delete'|'patch', item?: {...}, id?: '...', patch?: {...}, resource?: 'items' }
 *
 * Notes:
 *  - This adapter is intentionally conservative and KISS.
 *  - Use `headersProvider` to inject dynamic headers (CSRF token, auth).
 */

import type { CrudAdapter, CrudChangeEvent, ListParams, ListResult, ID, HeadersProvider } from "./adapter.interface";

type SseAdapterOptions = {
  baseUrl: string; // e.g. /api/items
  resource?: string; // optional logical resource name used for filtering
  sseUrl?: string; // explicit SSE endpoint, otherwise `${baseUrl}/sse`
  headersProvider?: HeadersProvider;
  /**
   * Reconnect strategy
   */
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
};

/* Simple helper to build query string from ListParams (minimal & safe) */
function buildQuery(params?: ListParams): string {
  if (!params) return "";
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object") {
      try {
        qp.append(k, JSON.stringify(v));
      } catch {
        qp.append(k, String(v));
      }
    } else {
      qp.append(k, String(v));
    }
  }
  const s = qp.toString();
  return s ? `?${s}` : "";
}

function safeParseJson<T = any>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * SSE Adapter
 */
export class SseAdapter<T = any> implements CrudAdapter<T> {
  public baseUrl: string;
  public sseUrl: string;
  public resource?: string;
  private headersProvider?: HeadersProvider;

  // Reconnect/backoff config
  private reconnectInitialDelayMs: number;
  private reconnectMaxDelayMs: number;

  // Runtime
  private es?: EventSource;

  constructor(opts: SseAdapterOptions) {
    if (!opts || !opts.baseUrl) {
      throw new Error("SseAdapter requires a baseUrl");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.sseUrl = opts.sseUrl ? opts.sseUrl : `${this.baseUrl}/sse`;
    this.resource = opts.resource;
    this.headersProvider = opts.headersProvider;
    this.reconnectInitialDelayMs = opts.reconnectInitialDelayMs ?? 1000;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 30000;
  }

  // ----- REST methods (basic JSON fetch wrappers) -----

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

  public async list(params?: ListParams): Promise<ListResult<T>> {
    const qp = buildQuery(params);
    const url = `${this.baseUrl}${qp}`;
    const headers = await this.getHeaders();
    const res = await fetch(url, { method: "GET", headers, credentials: "same-origin" });
    const parsed = await this.handleResponse(res);
    if (Array.isArray(parsed)) {
      return { items: parsed };
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).items)) {
      return parsed as ListResult<T>;
    }
    return { items: (parsed && (parsed as any).items) || [] };
  }

  public async get(id: ID): Promise<T> {
    const headers = await this.getHeaders();
    const url = `${this.baseUrl}/${encodeURIComponent(String(id))}`;
    const res = await fetch(url, { method: "GET", headers, credentials: "same-origin" });
    return this.handleResponse(res);
  }

  public async create(payload: Record<string, any>): Promise<T> {
    const headers = await this.getHeaders();
    const url = this.baseUrl;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), credentials: "same-origin" });
    return this.handleResponse(res);
  }

  public async update(id: ID, payload: Record<string, any>): Promise<T> {
    const headers = await this.getHeaders();
    const url = `${this.baseUrl}/${encodeURIComponent(String(id))}`;
    const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(payload), credentials: "same-origin" });
    return this.handleResponse(res);
  }

  public async delete(id: ID): Promise<{ ok: boolean }> {
    const headers = await this.getHeaders();
    const url = `${this.baseUrl}/${encodeURIComponent(String(id))}`;
    const res = await fetch(url, { method: "DELETE", headers, credentials: "same-origin" });
    const parsed = await this.handleResponse(res);
    if (parsed === "" || parsed == null) return { ok: true };
    if (typeof parsed === "object" && typeof (parsed as any).ok !== "undefined") return parsed as { ok: boolean };
    return { ok: true };
  }

  // ----- SSE subscribe -----
  //
  // The subscribe method returns { unsubscribe() } and will attempt reconnects.
  // Each incoming SSE message is expected to be JSON in event.data; we forward
  // parsed shape as CrudChangeEvent via onChange.
  public subscribe(opts: { onChange: (ev: CrudChangeEvent<T>) => void; onError?: (err: any) => void }) {
    const onChange = opts.onChange;
    const onError = opts.onError;

    let closed = false;
    let es: EventSource | undefined;
    let reconnectDelay = this.reconnectInitialDelayMs;

    const buildUrlWithHeaders = async (): Promise<string> => {
      // EventSource doesn't support custom headers directly. If headersProvider
      // returns a token, we try to append it as a query param `__sse_auth` as fallback.
      // Servers may accept tokens via query param for SSE streams (CORS considerations).
      if (!this.headersProvider) return this.sseUrl;
      try {
        const h = await Promise.resolve(this.headersProvider());
        // Common patterns: Authorization: Bearer <token> or X-CSRF-Token
        // We will append any simple token-like header as __sse_auth if present.
        const token = h["Authorization"] || h["authorization"] || h["x-sse-token"] || h["x-csrf-token"] || h["X-CSRF-Token"];
        if (token) {
          const u = new URL(this.sseUrl, typeof location !== "undefined" ? location.href : undefined);
          u.searchParams.set("__sse_auth", String(token).replace(/^Bearer\s+/i, ""));
          return u.toString();
        }
      } catch {
        // ignore header provider errors and fall through
      }
      return this.sseUrl;
    };

    const connect = async () => {
      if (closed) return;
      const url = await buildUrlWithHeaders();
      try {
        // Create EventSource
        es = new EventSource(url, { withCredentials: true } as any);
        this.es = es;
        reconnectDelay = this.reconnectInitialDelayMs;

        es.onopen = () => {
          // reset backoff
          reconnectDelay = this.reconnectInitialDelayMs;
        };

        es.onmessage = (ev: MessageEvent) => {
          if (closed) return;
          if (!ev || typeof ev.data !== "string") return;
          const parsed = safeParseJson<any>(ev.data);
          if (!parsed) {
            // Try to forward raw as message with type 'message' if consumer wants it
            try {
              onError && onError(new Error("SSE: failed to parse JSON message"));
            } catch {}
            return;
          }

          // Optionally filter by resource
          if (this.resource && parsed.resource && parsed.resource !== this.resource) {
            return;
          }

          // Normalize to CrudChangeEvent shape if possible
          const type = parsed.type;
          if (!type) return;
          let evOut: CrudChangeEvent<T> | null = null;
          if (type === "create" && parsed.item) {
            evOut = { type: "create", item: parsed.item as T };
          } else if (type === "update" && parsed.item) {
            evOut = { type: "update", item: parsed.item as T };
          } else if (type === "patch" && (parsed.patch || parsed.id)) {
            evOut = { type: "patch", id: parsed.id, patch: parsed.patch };
          } else if (type === "delete" && parsed.id) {
            evOut = { type: "delete", id: parsed.id };
          } else {
            // Unknown/other message types: attempt to forward if they look like a change
            if (parsed.item && parsed.type) {
              const t = parsed.type;
              if (t === "create" || t === "update") evOut = { type: t, item: parsed.item as T };
            }
          }

          if (evOut) {
            try {
              onChange(evOut);
            } catch (err) {
              // swallow consumer errors
              try {
                onError && onError(err);
              } catch {}
            }
          }
        };

        es.onerror = (err) => {
          // EventSource has an error. Close and attempt reconnect with backoff.
          try {
            onError && onError(err || new Error("SSE error"));
          } catch {}
          // Close current source and schedule reconnect
          try {
            es && es.close();
          } catch {}
          if (closed) return;
          setTimeout(() => {
            // exponential backoff
            reconnectDelay = Math.min(reconnectDelay * 2, this.reconnectMaxDelayMs);
            connect().catch(() => {
              // swallow
            });
          }, reconnectDelay);
        };
      } catch (err) {
        try {
          onError && onError(err);
        } catch {}
        if (closed) return;
        setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, this.reconnectMaxDelayMs);
          connect().catch(() => {});
        }, reconnectDelay);
      }
    };

    // Start connection (async)
    connect().catch((err) => {
      try {
        onError && onError(err);
      } catch {}
    });

    return {
      unsubscribe: () => {
        closed = true;
        // Close the ephemeral EventSource created for this subscription if present.
        try {
          if (es) es.close();
        } catch {}
        // Also close any class-level EventSource reference.
        try {
          if (this.es) this.es.close();
        } catch {}
      },
    };
  }
}

/* Convenience factory */
export function createSseAdapter<T = any>(opts: SseAdapterOptions): CrudAdapter<T> {
  return new SseAdapter<T>(opts);
}

export default SseAdapter;
