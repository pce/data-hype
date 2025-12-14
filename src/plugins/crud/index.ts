/**
 * src/plugins/crud/index.ts
 *
 * CRUD plugin factory (DI-friendly)
 *
 * Overview
 * - Exported factory: `createCrudPlugin(config?)` returns a Hype-compatible plugin object.
 * - Designed for dependency injection: adapters (REST, SSE, WS) implement the `CrudAdapter`
 *   interface and are provided to the factory; sensible defaults (RestAdapter) are available.
 * - The plugin attaches a non-enumerable `crud` property on the Hype instance exposing a
 *   small, well-documented public API (list/get/create/update/delete/subscribe/resetCache).
 *
 * Security & Design Principles
 * - Secure-by-design: prefer DOM APIs, avoid string-based HTML interpolation, and emit
 *   high-level CustomEvents rather than coupling to DOM internals.
 * - KISS and composable: the plugin is intentionally small and delegates transport to adapters.
 * - SOLID / DI: the factory accepts an `adapter` or `endpoint` config; consumers may pass
 *   different adapter implementations without changing the plugin internals.
 *
 * Lifecycle (developer-facing)
 * - createCrudPlugin(config) -> returns plugin object with `install(hypeInstance)`:
 *     - install attaches `hype.crud` (non-enumerable) and `hype.crudAttributes`.
 *     - If a `resource` is provided in the factory config and the adapter supports
 *       `subscribe()`, the plugin will automatically subscribe and forward remote
 *       changes to `crud:remote:{type}` events.
 *     - The `install` returns a `cleanup()` function which removes exposed properties
 *       and unsubscribes any adapter subscriptions. Hype will call cleanup on detach/destroy.
 *
 * Example: CRUD optimistic create chronology
 * 1. User clicks Create -> `datatable` opens `liveform` -> on submit `serializeForm` -> `prepareRequestBody`
 * 2. UI calls `crud.create(payload, { optimistic: true })`
 * 3. `crud` emits `crud:before:create` then applies an optimistic insert to cache with a temp id and
 *    emits `crud:item:created` with `optimistic: true`.
 * 4. UI shows temporary row with spinner bound to optimistic state (via reactive system).
 * 5. Adapter POSTs to server.
 * 6. On success adapter returns created item with final id -> `crud` reconciles: replaces temp id in cache,
 *    emits `crud:item:created` with `optimistic: false` (final), and optionally emits `crud:after:create`.
 * 7. If server returns validation (422) or other error -> `crud` removes optimistic placeholder,
 *    emits `crud:error` with details (validation payload), and UI displays errors (via `reactive`).
 *
 * Testing & Dev ergonomics
 * - The plugin emits predictable DOM CustomEvents (e.g. `crud:before:list`, `crud:after:list`,
 *   `crud:item:created`, `crud:item:updated`, `crud:error`) which are easy to capture in unit
 *   and integration tests (Vitest, happy-dom).
 * - When writing tests, instantiate the plugin with a mock adapter implementing `CrudAdapter`
 *   and attach it to a lightweight fake `hype` instance having `getConfig()` to supply attribute prefix.
 *
 * Notes for maintainers
 * - Keep the plugin core adapter-agnostic: any transport concerns belong in adapters under
 *   `src/plugins/crud/*` (rest, sse, ws).
 * - Favor small, well-scoped changes: the lifecycle is simple (install -> attach props -> optional subscribe -> return cleanup).
 * - Document adapter message contract for SSE/WS so `subscribe()` implementations can normalize events into
 *   `{ type: 'create'|'update'|'delete'|'patch', item?, id?, patch?, resource? }`.
 */

import type { CrudAdapter, CrudChangeEvent, ListParams, ListResult, ID, RestAdapterOptions } from "./adapter.interface";
import { RestAdapter } from "./adapter.interface";

/* -------------------------------------------------------------------------- */
/* Config & types                                                              */
/* -------------------------------------------------------------------------- */

export type CrudPluginConfig<T = any> = {
  resource?: string; // optional default resource name (e.g. "items")
  endpoint?: string; // optional base URL used to construct a default RestAdapter
  adapter?: CrudAdapter<T>; // optional custom adapter
  pk?: string; // primary key field name (default: "id")
  attributePrefix?: string; // override Hype attribute prefix (defaults to Hype config or "hype")
  debug?: boolean;
};

/* Public API surface exposed on the Hype instance under `hype.crud` */
export type CrudPublicAPI<T = any> = {
  list: (resourceOrParams?: string | ListParams, maybeParams?: ListParams) => Promise<ListResult<T>>;
  get: (resource: string, id: ID) => Promise<T>;
  create: (resource: string, payload: Record<string, any>, opts?: { optimistic?: boolean }) => Promise<T>;
  update: (resource: string, id: ID, payload: Record<string, any>, opts?: { optimistic?: boolean }) => Promise<T>;
  delete: (resource: string, id: ID, opts?: { optimistic?: boolean }) => Promise<{ ok: boolean }>;
  subscribe?: (resource: string, cb: (ev: CrudChangeEvent<T>) => void) => { unsubscribe(): void };
  resetCache: (resource?: string) => void;
  getConfig: () => CrudPluginConfig<T>;
};

/* -------------------------------------------------------------------------- */
/* Utility helpers                                                             */
/* -------------------------------------------------------------------------- */

function attachProp(obj: any, name: string, value: any) {
  try {
    Object.defineProperty(obj, name, {
      value,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  } catch {
    // best-effort fallback
    // eslint-disable-next-line no-param-reassign
    obj[name] = value;
  }
}

function dispatchCrudEvent(name: string, detail: any) {
  try {
    const ev = new CustomEvent(name, { detail, bubbles: true, composed: true });
    if (typeof document !== "undefined" && document && typeof document.dispatchEvent === "function") {
      document.dispatchEvent(ev);
    }
  } catch {
    // ignore in non-DOM envs
  }
}

function makeQueryKey(resource: string, params?: ListParams) {
  try {
    return `${resource}::${params ? JSON.stringify(params) : "*"}`;
  } catch {
    return `${resource}::${String(params)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory: createCrudPlugin                                                   */
/* -------------------------------------------------------------------------- */

export function createCrudPlugin<T = any>(cfg: CrudPluginConfig<T> = {}) {
  const globalConfig: CrudPluginConfig<T> = { ...cfg };

  // Internal caches and in-flight maps (per plugin instance)
  const listsCache: Map<string, ListResult<T>> = new Map();
  const itemsCache: Map<string, Map<ID, T>> = new Map();
  const inFlight: Map<string, Promise<any>> = new Map();

  // adapter holder (may be lazily created)
  let adapter: CrudAdapter<T> | undefined = globalConfig.adapter;

  function ensureAdapter(resource?: string): CrudAdapter<T> {
    if (adapter) return adapter;
    const baseUrl = globalConfig.endpoint ?? (resource ? `/${resource}` : undefined);
    if (!baseUrl) {
      throw new Error("CRUD plugin: no adapter configured and no endpoint provided");
    }
    // Use the simple RestAdapter from adapter.interface
    adapter = new RestAdapter<T>({ baseUrl } as RestAdapterOptions);
    return adapter;
  }

  // Cache helpers
  function ensureItemsMap(resource: string) {
    let m = itemsCache.get(resource);
    if (!m) {
      m = new Map<ID, T>();
      itemsCache.set(resource, m);
    }
    return m;
  }

  // applyCacheList removed — caching is performed inline where lists are fetched and when
  // individual items are created/updated/deleted to avoid an unused helper and keep
  // responsibilities explicit in the call sites.

  // Emit event helper: emit DOM CustomEvent + try to call hype.emit if available (done by install)
  function emit(hypeInstance: any | undefined, name: string, payload: any) {
    // DOM event
    dispatchCrudEvent(name, payload);

    // try hype instance emit style if present
    try {
      if (hypeInstance && typeof hypeInstance.emit === "function") {
        hypeInstance.emit(name, payload);
      } else if (hypeInstance && hypeInstance.events && typeof hypeInstance.events.dispatch === "function") {
        // fallback: some Hype internals offer an EventSystem; try to dispatch on document then
        try {
          // many Hype dispatchers require an element first, so we pass document.body if available
          // but avoid throwing if API differs
          const target = typeof document !== "undefined" ? document.body : undefined;
          if (target) (hypeInstance.events as any).dispatch(target, name, payload);
        } catch {
          // ignore
        }
      } else if (hypeInstance && typeof hypeInstance.pub === "function") {
        // also publish via pubsub if attached
        try {
          hypeInstance.pub(name, payload);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore any emission errors
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Core operations                                                           */
  /* ------------------------------------------------------------------------ */

  async function list(hypeInstance: any | undefined, resource: string, params?: ListParams): Promise<ListResult<T>> {
    const key = makeQueryKey(resource, params);
    // dedupe in-flight
    if (inFlight.has(key)) return inFlight.get(key) as Promise<ListResult<T>>;

    emit(hypeInstance, "crud:before:list", { resource, params });

    const p = (async () => {
      const a = ensureAdapter(resource);
      const res = await a.list(params);
      // cache by list key and by id
      listsCache.set(key, res);
      const map = ensureItemsMap(resource);
      for (const it of res.items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const id = (it as any)[globalConfig.pk || "id"];
        if (id !== undefined) map.set(id, it);
      }
      emit(hypeInstance, "crud:after:list", { resource, params, result: res });
      return res;
    })();

    inFlight.set(key, p);
    try {
      const r = await p;
      return r;
    } finally {
      inFlight.delete(key);
    }
  }

  async function get(hypeInstance: any | undefined, resource: string, id: ID): Promise<T> {
    emit(hypeInstance, "crud:before:get", { resource, id });
    const map = ensureItemsMap(resource);
    if (map.has(id)) {
      const cached = map.get(id) as T;
      emit(hypeInstance, "crud:after:get", { resource, id, item: cached });
      return Promise.resolve(cached);
    }
    const a = ensureAdapter(resource);
    const item = await a.get(id);
    // cache
    map.set(id, item);
    emit(hypeInstance, "crud:after:get", { resource, id, item });
    return item;
  }

  async function create(hypeInstance: any | undefined, resource: string, payload: Record<string, any>, opts?: { optimistic?: boolean }) {
    emit(hypeInstance, "crud:before:create", { resource, payload });
    const a = ensureAdapter(resource);

    if (opts?.optimistic) {
      // create optimistic placeholder with temp id
      const tempId = `temp:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const optimisticItem = { ...(payload as any), [globalConfig.pk || "id"]: tempId } as T;
      ensureItemsMap(resource).set(tempId, optimisticItem);
      emit(hypeInstance, "crud:item:created", { resource, item: optimisticItem, optimistic: true });
      try {
        const real = await a.create(payload);
        // replace temp id in cache
        const map = ensureItemsMap(resource);
        map.delete(tempId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realId = (real as any)[globalConfig.pk || "id"];
        if (realId !== undefined) map.set(realId, real);
        emit(hypeInstance, "crud:item:created", { resource, item: real, optimistic: false });
        return real;
      } catch (err) {
        // rollback optimistic
        ensureItemsMap(resource).delete(tempId);
        emit(hypeInstance, "crud:error", { resource, action: "create", error: err });
        throw err;
      }
    }

    // not optimistic
    try {
      const created = await a.create(payload);
      // cache
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (created as any)[globalConfig.pk || "id"];
      if (id !== undefined) ensureItemsMap(resource).set(id, created);
      emit(hypeInstance, "crud:item:created", { resource, item: created });
      return created;
    } catch (err) {
      emit(hypeInstance, "crud:error", { resource, action: "create", error: err });
      throw err;
    }
  }

  async function update(hypeInstance: any | undefined, resource: string, id: ID, payload: Record<string, any>, opts?: { optimistic?: boolean }) {
    emit(hypeInstance, "crud:before:update", { resource, id, payload });
    const a = ensureAdapter(resource);

    if (opts?.optimistic) {
      // snapshot current
      const map = ensureItemsMap(resource);
      const before = map.get(id);
      // apply optimistic patch (shallow)
      const optimistic = { ...(before as any), ...(payload as any) } as T;
      map.set(id, optimistic);
      emit(hypeInstance, "crud:item:updated", { resource, item: optimistic, optimistic: true });
      try {
        const real = await a.update(id, payload);
        map.set(id, real);
        emit(hypeInstance, "crud:item:updated", { resource, item: real, optimistic: false });
        return real;
      } catch (err) {
        // rollback
        if (before !== undefined) map.set(id, before as T);
        emit(hypeInstance, "crud:error", { resource, action: "update", error: err });
        throw err;
      }
    }

    try {
      const updated = await a.update(id, payload);
      ensureItemsMap(resource).set(id, updated);
      emit(hypeInstance, "crud:item:updated", { resource, item: updated });
      return updated;
    } catch (err) {
      emit(hypeInstance, "crud:error", { resource, action: "update", error: err });
      throw err;
    }
  }

  async function del(hypeInstance: any | undefined, resource: string, id: ID, opts?: { optimistic?: boolean }) {
    emit(hypeInstance, "crud:before:delete", { resource, id });
    const a = ensureAdapter(resource);

    if (opts?.optimistic) {
      const map = ensureItemsMap(resource);
      const before = map.get(id);
      map.delete(id);
      emit(hypeInstance, "crud:item:deleted", { resource, id, optimistic: true });
      try {
        const r = await a.delete(id);
        emit(hypeInstance, "crud:item:deleted", { resource, id, optimistic: false });
        return r;
      } catch (err) {
        // rollback
        if (before !== undefined) map.set(id, before as T);
        emit(hypeInstance, "crud:error", { resource, action: "delete", error: err });
        throw err;
      }
    }

    try {
      const result = await a.delete(id);
      ensureItemsMap(resource).delete(id);
      emit(hypeInstance, "crud:item:deleted", { resource, id });
      return result;
    } catch (err) {
      emit(hypeInstance, "crud:error", { resource, action: "delete", error: err });
      throw err;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Plugin object returned by factory                                         */
  /* ------------------------------------------------------------------------ */

  function pluginObject() {
    return {
      install(hypeInstance: any) {
        // determine attribute prefix: prefer plugin config -> Hype config -> "hype"
        const hypeCfgPrefix = hypeInstance && typeof hypeInstance.getConfig === "function" ? hypeInstance.getConfig().attributePrefix : undefined;
        const attrPrefix = globalConfig.attributePrefix ?? hypeCfgPrefix ?? "hype";

        // attribute names used by consumers (exposed as convenience)
        const attributes = {
          crudIndex: `data-${attrPrefix}-crud-index`,
          crudId: `data-${attrPrefix}-crud-id`,
        };

        // expose the public API on the hype instance under `.crud`
        const publicApi: CrudPublicAPI<T> = {
          list: (resourceOrParams?: string | ListParams, maybeParams?: ListParams) => {
            if (typeof resourceOrParams === "string") {
              return list(hypeInstance, resourceOrParams, maybeParams);
            }
            // if first arg is params use configured default resource
            const params = (resourceOrParams as ListParams) || {};
            const resource = globalConfig.resource || "";
            if (!resource) {
              return Promise.reject(new Error("CRUD list requires a resource name when not provided in factory config"));
            }
            return list(hypeInstance, resource, params);
          },
          get: (resource: string, id: ID) => get(hypeInstance, resource, id),
          create: (resource: string, payload: Record<string, any>, opts?: { optimistic?: boolean }) => create(hypeInstance, resource, payload, opts),
          update: (resource: string, id: ID, payload: Record<string, any>, opts?: { optimistic?: boolean }) =>
            update(hypeInstance, resource, id, payload, opts),
          delete: (resource: string, id: ID, opts?: { optimistic?: boolean }) => del(hypeInstance, resource, id, opts),
          subscribe: (resource: string, cb: (ev: CrudChangeEvent<T>) => void) => {
            const a = ensureAdapter(resource);
            if (!a.subscribe) {
              // return a noop unsubscribe
              return { unsubscribe() {} };
            }
            const sub = a.subscribe({ onChange: cb, onError: (err: any) => emit(hypeInstance, "crud:error", { resource, error: err }) });
            return sub;
          },
          resetCache: (resource?: string) => {
            if (resource) {
              itemsCache.delete(resource);
              // clear any lists for that resource
              for (const k of Array.from(listsCache.keys())) {
                if (k.startsWith(`${resource}::`)) listsCache.delete(k);
              }
            } else {
              itemsCache.clear();
              listsCache.clear();
            }
          },
          getConfig: () => ({ ...globalConfig }),
        };

        // Attach non-enumerable props: `crud`, and convenience names for attributes
        attachProp(hypeInstance, "crud", publicApi);
        attachProp(hypeInstance, "crudAttributes", attributes);

        // Also expose top-level convenience methods on hype (if not present)
        try {
          if (!hypeInstance.getCrud) attachProp(hypeInstance, "getCrud", publicApi.get);
          if (!hypeInstance.listCrud) attachProp(hypeInstance, "listCrud", publicApi.list);
        } catch {
          // ignore
        }

        // Optionally wire adapter subscribe -> global events to keep simple apps in sync
        const subs: Array<{ unsubscribe(): void }> = [];
        // If a configured adapter has a subscribe method and a resource was provided at creation time,
        // automatically subscribe to the resource push events and forward them to Hype events.
        try {
          const resource = globalConfig.resource;
          if (resource) {
            const a = globalConfig.adapter ?? (globalConfig.endpoint ? new RestAdapter<T>({ baseUrl: globalConfig.endpoint }) : undefined);
            if (a && typeof a.subscribe === "function") {
              const s = a.subscribe({
                onChange(ev) {
                  // update cache and emit events
                  if (ev.type === "create" && (ev as any).item) {
                    const it = (ev as any).item as T;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const id = (it as any)[globalConfig.pk || "id"];
                    if (id !== undefined) ensureItemsMap(resource).set(id, it);
                  } else if ((ev as any).id) {
                    if (ev.type === "delete") ensureItemsMap(resource).delete((ev as any).id);
                  }
                  emit(hypeInstance, `crud:remote:${ev.type}`, { resource, change: ev });
                },
                onError(err) {
                  emit(hypeInstance, "crud:error", { resource, error: err });
                },
              });
              subs.push(s);
            }
          }
        } catch {
          // ignore subscribe errors
        }

        // Return cleanup function used by Hype.attach to remove plugin
        const cleanup = () => {
          try {
            delete hypeInstance.crud;
          } catch {}
          try {
            delete hypeInstance.crudAttributes;
          } catch {}
          try {
            delete (hypeInstance as any).getCrud;
          } catch {}
          try {
            delete (hypeInstance as any).listCrud;
          } catch {}
          for (const s of subs) {
            try {
              s.unsubscribe();
            } catch {
              // ignore
            }
          }
        };

        return cleanup;
      },
    };
  }

  return pluginObject();
}

export default createCrudPlugin;
