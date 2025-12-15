/**
 * src/loader.ts
 *
 * Lightweight client loader module.
 *
 * Responsibilities:
 * - Progressive, non-blocking load of the Hype runtime at /static/js/hype.js
 * - Expose runtime state on `window.hypeModule` / `window.hypeModuleInitialized`
 * - Delegate CSRF/auth helpers to an immutable client created by `src/client.ts`
 * - Provide DOM helpers to bind a simple login form and logout buttons
 *
 * Notes:
 * - All network calls use `credentials: 'same-origin'` so cookie-based secrets work.
 * - This module is an external ES module so it is CSP-friendly (no inline scripts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// client import removed from core loader. Consumers may provide an AuthClient to createLoader().

// default HYPE path removed - loader is now configurable via `createLoader(opts)`
// Consumers may pass `hypePath` to the factory.

declare global {
  interface Window {
    hypeModule?: any;
    hypeModuleInitialized?: boolean;
    __hype_loader_debug?: boolean;
  }
}



/**
 * We prefer the provided default immutable auth client instance exported by
 * `src/client.ts`. If for some reason that isn't available (eg. a different
 * bundling arrangement), fall back to creating a new client with defaults.
 */
export type AuthClient = {
  fetchJson?: (url: string, init?: RequestInit) => Promise<any>;
  getCsrfToken?: () => Promise<string | null>;
  login?: (username: string, password: string) => Promise<any>;
  loginWithPayload?: (payload: any) => Promise<any>;
  logout?: () => Promise<any>;
  me?: () => Promise<any>;
  bindLoginForm?: (scope?: ParentNode) => void;
  bindLogoutButtons?: (scope?: ParentNode) => void;
};

/**
 * Config-driven loader factory.
 *
 * Usage:
 *   const loader = createLoader({ hypePath: '/static/js/hype.js', authClient });
 *   await loader.loadHypeRuntime();
 *
 * The factory avoids importing or assuming an application-level client. If an
 * `authClient` is provided it will be used to expose helper bindings; otherwise
 * auth helpers are no-ops.
 */
export function createLoader(opts?: { hypePath?: string; authClient?: AuthClient }) {
  const hypePath = opts?.hypePath ?? "/static/js/hype.js";
  const auth = opts?.authClient;

  async function loadHypeRuntime(): Promise<any | null> {
    try {
      const mod = await import(/* webpackIgnore: true */ hypePath).catch(() => null);
      if (!mod) {
        (window as any).hypeModule = null;
        (window as any).hypeModuleInitialized = false;
        if ((window as any).__hype_loader_debug) console.debug("[loader] Hype runtime not available");
        return null;
      }

      // Normalize runtime export shapes:
      // - preferred: module provides `createHype()` factory -> call it to get an instance
      // - fallback: module exports a ready instance as `hype` / default / module itself
      let runtime: any = null;
      try {
        if (mod && typeof (mod as any).createHype === "function") {
          runtime = (mod as any).createHype();
        } else {
          runtime = (mod && (mod.hype || mod.default || mod)) || null;
        }
      } catch (err) {
        runtime = null;
        if ((window as any).__hype_loader_debug) console.warn("[loader] createHype() threw:", err);
      }

      (window as any).hypeModule = runtime;

      if (runtime) {
        try {
          // Preferred startup method is `run()` (explicit and non-guessing).
          // Fall back to `init()` for older runtimes that still expose it.
          if (typeof (runtime as any).run === "function") {
            const maybe = (runtime as any).run();
            if (maybe && typeof (maybe as any).then === "function") await maybe;
            (window as any).hypeModuleInitialized = true;
            if ((window as any).__hype_loader_debug) console.debug("[loader] Hype runtime started via run()");
          } else if (typeof (runtime as any).init === "function") {
            const maybe = (runtime as any).init();
            if (maybe && typeof (maybe as any).then === "function") await maybe;
            (window as any).hypeModuleInitialized = true;
            if ((window as any).__hype_loader_debug) console.debug("[loader] Hype runtime initialized via init()");
          } else {
            (window as any).hypeModuleInitialized = false;
            if ((window as any).__hype_loader_debug) console.debug("[loader] Hype module loaded but no run()/init() available");
          }
        } catch (err) {
          (window as any).hypeModuleInitialized = false;
          // Keep loader resilient: log and continue
          // eslint-disable-next-line no-console
          console.warn("[loader] Hype startup failed:", err);
        }
      } else {
        (window as any).hypeModuleInitialized = false;
        if ((window as any).__hype_loader_debug) console.debug("[loader] Hype runtime not available after import");
      }

      return runtime;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[loader] Failed to import Hype runtime:", err);
      (window as any).hypeModule = null;
      (window as any).hypeModuleInitialized = false;
      return null;
    }
  }

  // Expose optional auth helpers only when an auth client is provided.
  return {
    loadHypeRuntime,
    getCsrfToken: auth?.getCsrfToken ? () => auth.getCsrfToken!() : async () => null,
    login: auth?.login ? (u: string, p: string) => auth.login!(u, p) : async () => ({ ok: false }),
    logout: auth?.logout ? () => auth.logout!() : async () => ({ ok: false }),
    me: auth?.me ? () => auth.me!() : async () => ({ ok: false }),
    bindLoginForm: auth?.bindLoginForm ? (scope: ParentNode = document) => auth.bindLoginForm!(scope) : () => {},
    bindLogoutButtons: auth?.bindLogoutButtons ? (scope: ParentNode = document) => auth.bindLogoutButtons!(scope) : () => {},
  };
}

/* ---------------------------
   Notes
   --------------------------- */

/*
  The loader no longer performs auto-init on DOMContentLoaded and does not
  import an application auth client. Consumers should create a loader and use
  the returned helpers explicitly, for example:

    const loader = createLoader({ hypePath: '/static/js/hype.js', authClient });
    await loader.loadHypeRuntime();

  This keeps the core package minimal and unopinionated. Convenience helpers
  for auth/CRUD/UI should live in optional plugins or example code.
*/

export default createLoader;
