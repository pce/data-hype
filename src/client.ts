/**
 * src/client.ts
 *
 * Immutable client factory for auth & CSRF helpers.
 *
 * Usage:
 *   const authClient = createClient({ endpoints: { login: '/api/login' }, ... });
 *   // Preferred: bind a login form programmatically:
 *   authClient.bindLoginForm(document);
 *
 * The factory returns an object whose methods close over a frozen config object.
 * This avoids module-level mutable state and better aligns with immutability/security
 * principles.
 *
 * Note: The client also supports declarative, attribute-driven binding in a Hype
 * environment (see the `hype_login.html` demo). That allows you to keep forms
 * free of inline JS — prefer declarative attributes when possible for less JS
 * surface in your templates.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Fetcher } from "./interfaces/fetcher";
import { defaultFetcher } from "./interfaces/fetcher";

const DEFAULT_CSRF_ENDPOINT = "/csrf-token";
const DEFAULT_LOGIN_ENDPOINT = "/login";
const DEFAULT_LOGOUT_ENDPOINT = "/logout";
const DEFAULT_ME_ENDPOINT = "/me";

type JsonResp = { ok?: boolean; [k: string]: any };
type LoginResult = { ok: boolean; user?: any; error?: string; [k: string]: any };

declare global {
  interface Window {
    __hype_loader_debug?: boolean;
  }
}

/**
 * Client configuration shapes.
 */
export type ClientConfig = {
  endpoints?: {
    csrf?: string;
    login?: string;
    logout?: string;
    me?: string;
  };
  form?: {
    // CSS selector used to find login forms
    selector?: string;
    // Default field names; apps can set these to match their forms.
    fieldNames?: {
      username?: string;
      password?: string;
    };
    // A function that maps FormData + effective field names to the payload
    // that will be sent to the server. Return any serializable object.
    credentialMapper?: (fd: FormData, fieldNames: { username?: string; password?: string }) => any | Promise<any>;
  };
  messages?: {
    messageSelector?: string;
    messageTimeout?: number;
  };
  events?: {
    loginSuccess?: string;
    loginFailure?: string;
    logout?: string;
  };
};

/**
 * Create a deeply shallow-frozen config for immutability.
 * We freeze top-level objects and sub-objects that we create here.
 */
function buildConfig(cfg?: ClientConfig) {
  const endpoints = {
    csrf: DEFAULT_CSRF_ENDPOINT,
    login: DEFAULT_LOGIN_ENDPOINT,
    logout: DEFAULT_LOGOUT_ENDPOINT,
    me: DEFAULT_ME_ENDPOINT,
    ...(cfg && cfg.endpoints ? cfg.endpoints : {}),
  };

  const defaultFieldNames = { username: "username", password: "password" };
  const form = {
    selector: "form.hype-login-form, form#login-form",
    fieldNames: { ...defaultFieldNames, ...(cfg && cfg.form && cfg.form.fieldNames ? cfg.form.fieldNames : {}) },
    credentialMapper:
      (cfg && cfg.form && cfg.form.credentialMapper) ||
      ((fd: FormData, fieldNames: { username?: string; password?: string }) => {
        // default mapper returns { username, password }
        const username = String(fd.get(fieldNames.username || "username") || "").trim();
        const password = String(fd.get(fieldNames.password || "password") || "");
        return { username, password };
      }),
  };

  const messages = {
    messageSelector: "[data-login-message]",
    messageTimeout: 5000,
    ...(cfg && cfg.messages ? cfg.messages : {}),
  };

  const events = {
    loginSuccess: "auth:login",
    loginFailure: "auth:login:failed",
    logout: "auth:logout",
    ...(cfg && cfg.events ? cfg.events : {}),
  };

  // Freeze the constructed config to prevent mutation.
  Object.freeze(endpoints);
  Object.freeze(form.fieldNames);
  Object.freeze(form);
  Object.freeze(messages);
  Object.freeze(events);

  const frozen = Object.freeze({
    endpoints,
    form,
    messages,
    events,
  });

  return frozen;
}

/* ---------------------------
   Factory: createClient
   --------------------------- */

export function createClient(cfg?: ClientConfig, fetcher?: Fetcher) {
  const config = buildConfig(cfg);
  // Allow injection of a Fetcher for DI (auth wrappers, CSRF, testing). Fallback to global fetch.
  const _fetch: Fetcher = fetcher ?? ((input: RequestInfo, init?: RequestInit) => fetch(input, init));

  /* ---------------------------
     Low-level network helpers
     --------------------------- */

  async function fetchJson(url: string, init?: RequestInit, fetcherOverride?: Fetcher): Promise<JsonResp> {
    // allow per-call override of the fetcher; fall back to injected _fetch
    const usedFetch = fetcherOverride ?? _fetch;
    try {
      const resp = await usedFetch(url, init);
      const body = await resp.json().catch(() => {
        if (window.__hype_loader_debug) console.warn("[client] invalid json response from", url);
        return { ok: false, status: resp.status };
      });
      return { ...(body || {}), status: resp.status, ok: body && typeof body.ok !== "undefined" ? body.ok : resp.ok };
    } catch (err) {
      if (window.__hype_loader_debug) console.warn("[client] fetch error", url, err);
      return { ok: false, error: String(err) };
    }
  }

  async function getCsrfToken(endpoint: string = config.endpoints.csrf, fetcherOverride?: Fetcher): Promise<string | null> {
    const result = await fetchJson(endpoint, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }, fetcherOverride);
 
    if (!result || result.ok === false) {
      if (window.__hype_loader_debug) console.warn("[client] CSRF endpoint returned", (result as any)?.status, endpoint);
      return null;
    }
    if (result && typeof result.csrfToken === "string") return result.csrfToken;
    if (window.__hype_loader_debug) console.warn("[client] CSRF token missing in response", result);
    return null;
  }

  /**
   * Convenience: classic username/password login
   */
  async function login(username: string, password: string, endpoint: string = config.endpoints.login, fetcherOverride?: Fetcher): Promise<LoginResult> {
    if (!username || !password) return { ok: false, error: "username and password required" };
    const token = await getCsrfToken(config.endpoints.csrf, fetcherOverride);
    if (!token) return { ok: false, error: "unable to obtain CSRF token" };
 
    const body = await fetchJson(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": token,
      },
      body: JSON.stringify({ username, password }),
    }, fetcherOverride);
 
    if (!body || body.ok === false) {
      return { ok: false, ...(body as any) } as LoginResult;
    }
    return { ok: true, ...(body || {}) } as LoginResult;
  }

  /**
   * Generic login path for arbitrary payloads (passkeys, webauthn, custom shapes)
   */
  async function loginWithPayload(payload: any, endpoint: string = config.endpoints.login, fetcherOverride?: Fetcher): Promise<LoginResult> {
    if (!payload) return { ok: false, error: "credentials required" };
    const token = await getCsrfToken(config.endpoints.csrf, fetcherOverride);
    if (!token) return { ok: false, error: "unable to obtain CSRF token" };
 
    const body = await fetchJson(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": token,
      },
      body: JSON.stringify(payload),
    }, fetcherOverride);
 
    if (!body || body.ok === false) {
      return { ok: false, ...(body as any) } as LoginResult;
    }
    return { ok: true, ...(body || {}) } as LoginResult;
  }

  async function logout(endpoint: string = config.endpoints.logout, fetcherOverride?: Fetcher): Promise<JsonResp> {
    const token = await getCsrfToken(config.endpoints.csrf, fetcherOverride);
    if (!token) return { ok: false, error: "unable to obtain CSRF token" };
    const body = await fetchJson(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": token, Accept: "application/json" },
    }, fetcherOverride);
    return body;
  }

  async function me(endpoint: string = config.endpoints.me, fetcherOverride?: Fetcher): Promise<JsonResp> {
    const body = await fetchJson(endpoint, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }, fetcherOverride);
    return body;
  }

  /* ---------------------------
     DOM helpers (useful, but do not mutate config)
     --------------------------- */

  function showLoginMessage(formEl: HTMLFormElement | null, text: string, options: { level?: "info" | "error" } = {}) {
    const level = options.level || "info";
    if (!formEl) {
      if (level === "error") console.error(text);
      else console.log(text);
      return;
    }

    const selector = config.messages.messageSelector;
    const msgEl = formEl.querySelector<HTMLElement>(selector);
    if (msgEl) {
      msgEl.textContent = text;
      msgEl.classList.remove("ok", "error");
      msgEl.classList.add(level === "error" ? "error" : "ok");
      return;
    }

    const span = document.createElement("div");
    span.textContent = text;
    span.className = "hype-loader-msg " + (level === "error" ? "error" : "ok");
    formEl.appendChild(span);
    setTimeout(() => {
      try {
        span.remove();
      } catch {}
    }, config.messages.messageTimeout);
  }

  function serializeFormToObject(form: HTMLFormElement): Record<string, any> {
    const fd = new FormData(form);
    const out: Record<string, any> = {};
    fd.forEach((v, k) => {
      const val = v instanceof File ? v : String(v);
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        if (Array.isArray(out[k])) out[k].push(val);
        else out[k] = [out[k], val];
      } else {
        out[k] = val;
      }
    });
    return out;
  }

  async function extractCredentialsFromForm(form: HTMLFormElement, overrideFieldNames?: { username?: string; password?: string }): Promise<any> {
    // Support async credential mappers (e.g., those that call WebAuthn APIs)
    const fd = new FormData(form);
    const fieldNames = { ...config.form.fieldNames, ...(overrideFieldNames || {}) };
    return await config.form.credentialMapper(fd, fieldNames);
  }

  /**
   * Bind login forms using the client's immutable configuration.
   * - Attaches listener in the capture phase to reliably prevent native submit.
   * - If the credential mapper returns { username, password } (strings) we'll
   *   use the convenience `login` call; otherwise `loginWithPayload` is used.
   *
   * This function is intentionally ergonomic and small — it can be used
   * programmatically (preferred for progressive enhancement) or in Hype's
   * declarative attribute world (see `hype_login.html` demo for a template-only
   * integration).
   */
  function bindLoginForm(scope: ParentNode = document, localOptions?: { selector?: string; fieldNames?: { username?: string; password?: string } }) {
    const selector = localOptions?.selector || config.form.selector;
    const forms = Array.from(scope.querySelectorAll<HTMLFormElement>(selector));
    forms.forEach((form) => {
      if ((form as any)._hype_loader_bound) return;
      (form as any)._hype_loader_bound = true;

      form.addEventListener(
        "submit",
        async (ev) => {
          ev.preventDefault();
          showLoginMessage(form, "Signing in…");
          try {
            const payload = await extractCredentialsFromForm(form, localOptions?.fieldNames);
            if (!payload) {
              showLoginMessage(form, "No credentials provided", { level: "error" });
              document.dispatchEvent(new CustomEvent(config.events.loginFailure, { detail: { error: "no credentials" } }));
              return;
            }

            // Backwards-compatible fast path for simple username/password payloads
            if (payload && typeof payload === "object" && typeof payload.username === "string" && typeof payload.password === "string") {
              const res = await login(payload.username, payload.password, config.endpoints.login);
              if (res && res.ok) {
                showLoginMessage(form, "Signed in");
                document.dispatchEvent(new CustomEvent(config.events.loginSuccess, { detail: { user: (res as any).user || null } }));
              } else {
                const msg = (res && ((res as any).error || (res as any).message)) || "Login failed";
                showLoginMessage(form, String(msg), { level: "error" });
                document.dispatchEvent(new CustomEvent(config.events.loginFailure, { detail: { error: msg } }));
              }
            } else {
              // Generic payload path (passkeys / webauthn / custom)
              const res = await loginWithPayload(payload, config.endpoints.login);
              if (res && res.ok) {
                showLoginMessage(form, "Signed in");
                document.dispatchEvent(new CustomEvent(config.events.loginSuccess, { detail: { user: (res as any).user || null } }));
              } else {
                const msg = (res && ((res as any).error || (res as any).message)) || "Login failed";
                showLoginMessage(form, String(msg), { level: "error" });
                document.dispatchEvent(new CustomEvent(config.events.loginFailure, { detail: { error: msg } }));
              }
            }
          } catch (err) {
            showLoginMessage(form, "Login error", { level: "error" });
            if (window.__hype_loader_debug) console.error("[client] login form submit error:", err);
            document.dispatchEvent(new CustomEvent(config.events.loginFailure, { detail: { error: String(err) } }));
          }
        },
        true,
      );
    });
  }

  function bindLogoutButtons(scope: ParentNode = document, logoutEndpoint?: string): void {
    const els = Array.from(scope.querySelectorAll<HTMLElement>("[data-logout]"));
    els.forEach((el) => {
      if ((el as any)._hype_loader_logout_bound) return;
      (el as any)._hype_loader_logout_bound = true;
      el.addEventListener("click", async (ev) => {
        ev.preventDefault();
        try {
          const res = await logout(logoutEndpoint || config.endpoints.logout);
          if (res && (res as any).ok) {
            document.dispatchEvent(new CustomEvent(config.events.logout, { detail: {} }));
          } else {
            console.warn("[client] logout failed", res);
          }
        } catch (err) {
          console.warn("[client] logout error", err);
        }
      });
    });
  }

  /* ---------------------------
     Public API (methods close over frozen config)
     --------------------------- */

  const api = {
    // network
    fetchJson,
    getCsrfToken,
    login,
    loginWithPayload,
    logout,
    me,
    // DOM helpers
    serializeFormToObject,
    extractCredentialsFromForm,
    // binding helpers
    // - `bindLoginForm` is the preferred ergonomic programmatic binder
    bindLoginForm,
    bindLogoutButtons,
    // expose the frozen config for those who need to inspect (read-only)
    config,
  };

  return Object.freeze(api);
}

/* Convenience: export a default client instance configured with defaults.
   Consumers who want immutability should prefer calling `createClient` with
   their own config. */
export const defaultClient = createClient(undefined, defaultFetcher);
export default createClient;

/**
 * Backward-compatible named exports delegating to the default frozen client.
 *
 * Some parts of the codebase and third-party plugins historically imported
 * named helpers (e.g. `import { getCsrfToken } from './client'`). To remain
 * compatible with that usage pattern we provide thin delegating named
 * exports that call into the `defaultClient` instance. This keeps the new
 * immutable factory as the primary path while preserving prior import shapes
 * for build tooling and plugins.
 *
 * Note: These simple delegates intentionally use loose `any` typing to avoid
 * coupling consumers to the exact factory return type.
 */
export const fetchJson = (...args: any[]) => (defaultClient as any).fetchJson?.(...args);
export const getCsrfToken = (...args: any[]) => (defaultClient as any).getCsrfToken?.(...args);
export const login = (...args: any[]) => (defaultClient as any).login?.(...args);
export const loginWithPayload = (...args: any[]) => (defaultClient as any).loginWithPayload?.(...args);
export const logout = (...args: any[]) => (defaultClient as any).logout?.(...args);
export const me = (...args: any[]) => (defaultClient as any).me?.(...args);
export const serializeFormToObject = (...args: any[]) => (defaultClient as any).serializeFormToObject?.(...args);
export const extractCredentialsFromForm = (...args: any[]) => (defaultClient as any).extractCredentialsFromForm?.(...args);
// Preferred programmatic binder
export const bindLoginForm = (...args: any[]) => (defaultClient as any).bindLoginForm?.(...args);
export const bindLogoutButtons = (...args: any[]) => (defaultClient as any).bindLogoutButtons?.(...args);
