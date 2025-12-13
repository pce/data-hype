/**
 * src/loader.ts
 *
 * Lightweight client loader module.
 *
 * Responsibilities:
 * - Progressive, non-blocking load of the Hype runtime at /static/js/hype.js
 * - Expose runtime state on `window.hypeModule` / `window.hypeModuleInitialized`
 * - Delegate CSRF/auth helpers to `src/client.ts` so examples and the runtime share logic
 * - Provide DOM helpers to bind a simple login form and logout buttons
 *
 * Notes:
 * - All network calls use `credentials: 'same-origin'` so cookie-based secrets work.
 * - This module is an external ES module so it is CSP-friendly (no inline scripts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  getCsrfToken as clientGetCsrfToken,
  login as clientLogin,
  logout as clientLogout,
  me as clientMe,
  bindLoginForms as clientBindLoginForms,
  bindLogoutButtons as clientBindLogoutButtons,
} from "./client";

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
   Auth / CSRF helpers (delegated to src/client.ts)
   --------------------------- */

/**
 * Fetch a CSRF token from the server.
 * Delegates to `src/client.ts#getCsrfToken`.
 */
export async function getCsrfToken(): Promise<string | null> {
  return clientGetCsrfToken();
}

/**
 * Perform login via the server endpoint.
 * Delegates to `src/client.ts#login`.
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  return clientLogin(username, password);
}

/**
 * Logout via POST /logout. Server clears auth cookie.
 * Delegates to `src/client.ts#logout`.
 */
export async function logout(): Promise<JsonResp> {
  return clientLogout();
}

/**
 * Fetch current authenticated user info.
 * Delegates to `src/client.ts#me`.
 */
export async function me(): Promise<JsonResp> {
  return clientMe();
}

/* ---------------------------
   DOM helpers for simple auth forms (delegated)
   --------------------------- */

/**
 * Bind all login forms in the provided scope (default: document).
 * Delegates to `src/client.ts#bindLoginForms`.
 */
export function bindLoginForms(scope: ParentNode = document): void {
  return clientBindLoginForms(scope);
}

/**
 * Bind elements with [data-logout] in the provided scope (default: document).
 * Delegates to `src/client.ts#bindLogoutButtons`.
 */
export function bindLogoutButtons(scope: ParentNode = document): void {
  return clientBindLogoutButtons(scope);
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
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      bindLoginForms();
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
  });
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
  bindLoginForms,
  bindLogoutButtons,
};
