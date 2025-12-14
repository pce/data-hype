/**
 * src/plugins/crud/adapters.rest.ts
 *
 * Lightweight re-export and factory for the RestAdapter defined in
 * `adapter.interface.ts`. Keeping this in its own file makes it easy to
 * swap-in or extend the REST adapter without touching the core plugin.
 *
 * This module intentionally stays minimal — it re-exports the adapter and
 * provides a small factory helper to keep call sites concise.
 */

import { RestAdapter } from "./adapter.interface";
import type { RestAdapterOptions, CrudAdapter, CrudChangeEvent } from "./adapter.interface";

/**
 * Re-export the adapter class so consumers can import from a clear path:
 *  import { RestAdapter, createRestAdapter } from 'src/plugins/crud/adapters.rest';
 */
export { RestAdapter };
export type { RestAdapterOptions };

/**
 * Simple factory wrapper for convenience.
 * Returns an instance of RestAdapter implementing CrudAdapter<T>.
 */
export function createRestAdapter<T = any>(opts: RestAdapterOptions): CrudAdapter<T> {
  return new RestAdapter<T>(opts);
}

/**
 * Optional: export a thin adapter that wires in a headersProvider using a
 * provided function. This keeps adapter creation KISS while allowing callers
 * to inject dynamic headers (CSRF, auth tokens) easily.
 *
 * Example:
 *   const a = createRestAdapterWithHeaders({ baseUrl: '/api/items' }, () => ({ 'X-CSRF-Token': '...' }));
 */
export function createRestAdapterWithHeaders<T = any>(
  opts: RestAdapterOptions,
  headersProvider: () => Promise<Record<string, string>> | Record<string, string>,
): CrudAdapter<T> {
  const merged: RestAdapterOptions = { ...opts, headersProvider };
  return new RestAdapter<T>(merged);
}

export type { CrudChangeEvent };
