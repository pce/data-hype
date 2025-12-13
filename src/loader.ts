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

import createClient, { defaultClient as defaultAuthClient } from "./client";

const HYPE_PATH = "/static/js/hype.js";

declare global {
  interface Window {
    hypeModule?: any;
    hypeModuleInitialized?: boolean;
    __hype_loader_debug?: boolean;
  }
}

type JsonResp = { ok?: boolean; [k: string]: any };
type LoginResult = { ok: boolean; user?: any; error?: string; [k: string]: any };

/**
 * We prefer the provided default immutable auth client instance exported by
 * `src/client.ts`. If for some reason that isn't available (eg. a different
 * bundling arrangement), fall back to creating a new client with defaults.
 */
const authClient = (defaultAuthClient || createClient()) as {
  fetchJson?: (url: string, init?: RequestInit) => Promise<JsonResp>;
  getCsrfToken: () => Promise<string | null>;
  login: (username: string, password: string) => Promise<LoginResult>;
  loginWithPayload?: (payload: any) => Promise<LoginResult>;
  logout: () => Promise<JsonResp>;
  me: () => Promise<JsonResp>;
  bindLoginForm?: (scope?: ParentNode) => void;
  bindLogoutButtons: (scope?: ParentNode) => void;
};

/**
 * Attempt to dynamically import the Hype runtime.
 * Non-blocking: failures are logged but do not break page functionality.
 *
 * The loader uses a dynamic import with `webpackIgnore: true` so bundlers don't
 * try to include the runtime in the docs build. If the runtime is not present
 * the loader silently continues and pages still function (with reduced behavior).
 */
export async function loadHypeRuntime(): Promise<any | null> {
  try {
    const mod = await import(/* webpackIgnore: true */ HYPE_PATH).catch(() => null);
    if (!mod) {
      window.hypeModule = null;
      window.hypeModuleInitialized = false;
      if (window.__hype_loader_debug) console.debug("[loader] Hype runtime not available");
      return null;
    }

    const hype = (mod && (mod.hype || mod.default || mod)) || null;
    window.hypeModule = hype;

    if (hype && typeof hype.init === "function") {
      try {
        const maybe = hype.init();
        if (maybe && typeof (maybe as any).then === "function") await maybe;
        window.hypeModuleInitialized = true;
        if (window.__hype_loader_debug) console.debug("[loader] Hype runtime initialized");
      } catch (err) {
        window.hypeModuleInitialized = false;
        // Keep loader resilient: log and continue
        // eslint-disable-next-line no-console
        console.warn("[loader] Hype.init() failed:", err);
      }
    } else {
      window.hypeModuleInitialized = false;
      if (window.__hype_loader_debug) console.debug("[loader] Hype module loaded but no init() available");
    }

    return hype;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[loader] Failed to import Hype runtime:", err);
    window.hypeModule = null;
    window.hypeModuleInitialized = false;
    return null;
  }
}

/* ---------------------------
   Auth / CSRF helpers (delegated to immutable authClient)
   --------------------------- */

/**
 * Fetch a CSRF token from the server.
 * Delegates to the auth client instance.
 */
export async function getCsrfToken(): Promise<string | null> {
  return authClient.getCsrfToken();
}

/**
 * Perform login via the server endpoint.
 * Delegates to the auth client instance.
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  return authClient.login(username, password);
}

/**
 * Logout via POST /logout. Server clears auth cookie.
 * Delegates to the auth client instance.
 */
export async function logout(): Promise<JsonResp> {
  return authClient.logout();
}

/**
 * Fetch current authenticated user info.
 * Delegates to the auth client instance.
 */
export async function me(): Promise<JsonResp> {
  return authClient.me();
}

/* ---------------------------
   DOM helpers for simple auth forms (delegated)
   --------------------------- */

// Legacy alias `bindLoginForms` removed. Use `bindLoginForm(scope)` instead.

/**
 * Preferred programmatic binder name: bindLoginForm
 * This is provided as a convenience so callers can use the clearer singular API.
 */
export function bindLoginForm(scope: ParentNode = document): void {
  const fn = (authClient as any).bindLoginForm;
  if (typeof fn === "function") {
    return fn(scope);
  }
  // no-op if the client doesn't expose the binder; keeps loader resilient
  return;
}

/**
 * Bind elements with [data-logout] in the provided scope (default: document).
 * Delegates to the auth client instance's logout binder.
 */
export function bindLogoutButtons(scope: ParentNode = document): void {
  return authClient.bindLogoutButtons(scope);
}

/* ---------------------------
   Auto-init on DOMContentLoaded
   --------------------------- */

/**
 * On DOMContentLoaded:
 *  - Bind simple login forms and logout buttons (so pages work without extra JS)
 *  - Try to load the Hype runtime (best-effort)
 *  - Dispatch a `hype:loader:ready` event with runtime availability info
 */
if (typeof document !== "undefined") {
  const __hype_loader_init = async () => {
    try {
      bindLoginForm();
      bindLogoutButtons();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[loader] auth bind failed:", err);
    }

    try {
      await loadHypeRuntime();
    } catch {
      // errors are already handled/logged by loadHypeRuntime
    }

    try {
      document.dispatchEvent(
        new CustomEvent("hype:loader:ready", {
          detail: {
            runtimeAvailable: !!window.hypeModule,
            runtimeInitialized: !!window.hypeModuleInitialized,
          },
        }),
      );
    } catch {
      // best-effort, ignore if CustomEvent dispatch fails in odd environments
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void __hype_loader_init();
    });
  } else {
    void __hype_loader_init();
  }
}

/* ---------------------------
   Default export (convenience)
   --------------------------- */

export default {
  loadHypeRuntime,
  getCsrfToken,
  login,
  logout,
  me,
  bindLoginForm,
  bindLogoutButtons,
};
