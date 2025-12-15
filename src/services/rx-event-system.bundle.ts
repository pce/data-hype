/**
 * Rx-only bundle adapter
 *
 * Purpose:
 * - This module is intended for statically-bundled builds that MUST include
 *   RxJS. It will inject the statically-imported rxjs namespace into the
 *   runtime adapter and will explicitly error if rxjs is not present.
 *
 * Why:
 * - For rx-bundled artifacts we want deterministic semantics: always use the
 *   real rxjs Subject/Observable implementation (no fallback shim). This
 *   produces smaller runtime assumptions for consumers of the rx build and
 *   clearer typing for operator pipelines.
 *
 * Usage:
 *   import { createBundledRxEventSystem, BundledRxEventSystem } from './rx-event-system.bundle';
 *
 * Notes:
 * - Do NOT import this file in builds that should remain rx-less. Use the
 *   runtime-adaptive adapter instead (`src/services/rx-event-system.service.ts`).
 */

import RxEventSystem from "./rx-event-system.service";
// Statically include rxjs for the bundled adapter. This import is required for
// the rx-bundled artifact and will be present in builds that include rxjs.
// @ts-ignore: rxjs may be an optional peer dependency in some dev environments
import * as rxjs from "rxjs";

/**
 * Ensure the imported rxjs namespace looks usable.
 * Throws if rxjs is not present or doesn't expose a Subject constructor.
 */
function ensureRxAvailable() {
  if (!rxjs || typeof (rxjs as any).Subject !== "function") {
    throw new Error(
      "BundledRxEventSystem requires rxjs to be present in the bundle. " +
        "Import the rx-bundled artifact only in builds that include rxjs."
    );
  }
  return rxjs;
}

/**
 * Factory that returns an RxEventSystem instance pre-wired with the statically
 * imported rxjs namespace. This factory intentionally enforces the presence of
 * rxjs so the runtime path in the bundled artifact never falls back to a shim.
 *
 * @param opts - adapter options (emitDom, etc.)
 */
export function createBundledRxEventSystem(opts: { emitDom?: boolean } = {}) {
  const rx = ensureRxAvailable();
  return new RxEventSystem({ ...opts, rx });
}

/**
 * Convenience class that extends the runtime adapter and injects the static
 * rxjs namespace automatically. The constructor will throw when rxjs is missing.
 */
export class BundledRxEventSystem extends RxEventSystem {
  constructor(opts: { emitDom?: boolean } = {}) {
    const rx = ensureRxAvailable();
    super({ ...opts, rx });
  }
}

export default createBundledRxEventSystem;