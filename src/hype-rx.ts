/**
 * Rx-bundled Hype factory entry
 *
 * This module provides a convenience `createHype` factory that injects a
 * statically-bundled RxJS-backed event system by default so consumers can
 * import a single artifact that includes Rx without runtime detection.
 *
 * Usage:
 *   import { createHype } from './hype-rx';
 *   const hype = createHype({ root: '#app' });
 *
 * Notes:
 * - Consumers may still pass a custom event system or host if they want to
 *   override the bundled behavior.
 * - The default instance exported as `hype` is created but not auto-initialized.
 */

import { Hype } from "./hype";
import { BundledRxEventSystem } from "./services/rx-event-system.bundle";
import type { HypeConfig } from "./types";

/**
 * Create and return a new Hype instance for the rx-bundled artifact.
 *
 * Notes:
 * - This factory is simplified for the rx-bundled build and intentionally
 *   does NOT accept or honor a custom event system or host override. The
 *   bundled runtime is hardwired to use the statically-bundled Rx event
 *   system (BundledRxEventSystem) to keep semantics deterministic.
 *
 * - The second boolean parameter controls whether the instance should call
 *   `.init()` automatically (default: true). We intentionally avoid allowing
 *   consumers to swap the events/host in this entrypoint to prevent mixing
 *   runtime-shapes in the rx-bundled artifact.
 */
export function createHype(
  config?: Partial<HypeConfig> & { root?: string | Element },
  init: boolean = true
): Hype {
  // Always use the bundled Rx event system for this factory (no overrides).
  const resolvedEvents = new BundledRxEventSystem({ emitDom: true });

  // Do not accept or apply a host override in the rx-bundled factory.
  const instance = new Hype(config ?? ({} as Partial<HypeConfig>), resolvedEvents);

  // If the config provides a root, attempt to mount before init.
  try {
    const maybeRoot = (config as any)?.root;
    if (maybeRoot) {
      try {
        instance.mount(maybeRoot as string | Element);
      } catch (mountErr) {
        if ((config as any)?.debug || instance?.getConfig?.()?.debug) {
          // eslint-disable-next-line no-console
          console.warn("createHype(rx): mount failed for provided config.root:", mountErr);
        }
        // Do not rethrow — caller may wish to handle init themselves.
      }
    }
  } catch {
    // defensive no-op
  }

  if (init) {
    try {
      instance.init();
    } catch {
      // swallow to keep factory safe for environments that prefer explicit error handling
    }
  }

  return instance;
}

/**
 * Default Hype instance (convenience). Not auto-initialized.
 */
export const hype: Hype = createHype(undefined, false as any);

export { createBundledRxEventSystem, BundledRxEventSystem } from "./services/rx-event-system.bundle";
export default createHype;