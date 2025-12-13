/**
 * src/client.ts
 *
 * Client-side auth & CSRF helpers used by `src/loader.ts` and optionally by
 * a Hype plugin. Exported as named functions so the same helpers can be
 * consumed by multiple consumers.
 *
 * Notes:
 * - All requests use `credentials: 'same-origin'` so cookie-based sessions work.
 * - The dev loader exposes `window.__hype_loader_debug` to enable extra logging.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
 * Low-level helper to perform a fetch and parse JSON with graceful degradation.
 * Exported so tests can call it directly and to avoid unused warning.
 */
export async function fetchJson(url: string, init?: RequestInit): Promise<JsonResp> {
  try {
    const resp = await fetch(url, init);
    // Try to parse JSON, but tolerate invalid JSON (return object with ok:false)
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

/**
 * Fetch a CSRF token from the server.
 * The server should set a cookie-based secret; the token returned must be sent
 * on mutating requests in the 'X-CSRF-Token' header.
 */
export async function getCsrfToken(endpoint: string = DEFAULT_CSRF_ENDPOINT): Promise<string | null> {
  const result = await fetchJson(endpoint, {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!result || result.ok === false) {
    if (window.__hype_loader_debug) console.warn("[client] CSRF endpoint returned", (result as any)?.status, endpoint);
    return null;
  }

  if (result && typeof result.csrfToken === "string") return result.csrfToken;

  if (window.__hype_loader_debug) console.warn("[client] CSRF token missing in response", result);
  return null;
}

/**
 * Perform login via the server endpoint.
 * The server must accept the CSRF token in the X-CSRF-Token header and set an auth cookie.
 */
export async function login(username: string, password: string, endpoint: string = DEFAULT_LOGIN_ENDPOINT): Promise<LoginResult> {
  if (!username || !password) return { ok: false, error: "username and password required" };

  const token = await getCsrfToken();
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
  });

  // Normalize response
  if (!body || body.ok === false) {
    return { ok: false, ...(body as any) } as LoginResult;
  }
  return { ok: true, ...(body || {}) } as LoginResult;
}

/**
 * Logout via POST /logout. Server clears auth cookie.
 */
export async function logout(endpoint: string = DEFAULT_LOGOUT_ENDPOINT): Promise<JsonResp> {
  const token = await getCsrfToken();
  if (!token) return { ok: false, error: "unable to obtain CSRF token" };

  const body = await fetchJson(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": token, Accept: "application/json" },
  });

  return body;
}

/**
 * Fetch current authenticated user info.
 */
export async function me(endpoint: string = DEFAULT_ME_ENDPOINT): Promise<JsonResp> {
  const body = await fetchJson(endpoint, {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  return body;
}

/* ---------------------------
   DOM helpers for simple auth forms
   --------------------------- */

/**
 * Helper to show messages near a login form.
 * Looks for an element with [data-login-message] inside the form; otherwise logs to console.
 */
function showLoginMessage(formEl: HTMLFormElement | null, text: string, options: { level?: "info" | "error" } = {}) {
  const level = options.level || "info";
  if (!formEl) {
    if (level === "error") console.error(text);
    else console.log(text);
    return;
  }

  const msgEl = formEl.querySelector<HTMLElement>("[data-login-message]");
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
  }, 5000);
}

/**
 * Bind simple login forms:
 * - Looks for <form class="hype-login-form"> or form#login-form
 * - Prevents default submit, serializes username/password and calls login()
 * - Shows messages and emits a custom event "auth:login" on success
 */
export function bindLoginForms(scope: ParentNode = document, loginEndpoint?: string): void {
  const selector = "form.hype-login-form, form#login-form";
  const forms = Array.from(scope.querySelectorAll<HTMLFormElement>(selector));
  forms.forEach((form) => {
    // avoid double-binding
    if ((form as any)._hype_loader_bound) return;
    (form as any)._hype_loader_bound = true;

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      showLoginMessage(form, "Signing in…");
      const fd = new FormData(form);
      const username = String(fd.get("username") || "").trim();
      const password = String(fd.get("password") || "");
      try {
        const res = await login(username, password, loginEndpoint);
        if (res && res.ok) {
          showLoginMessage(form, "Signed in");
          // notify other client code
          document.dispatchEvent(new CustomEvent("auth:login", { detail: { user: (res as any).user || null } }));
        } else {
          const msg = (res && ((res as any).error || (res as any).message)) || "Login failed";
          showLoginMessage(form, String(msg), { level: "error" });
        }
      } catch (err) {
        showLoginMessage(form, "Login error", { level: "error" });
        if (window.__hype_loader_debug) console.error("[client] login form submit error:", err);
      }
    });
  });
}

/**
 * Bind logout buttons/links: elements with attribute [data-logout].
 * On click, calls logout() and emits "auth:logout" event on success.
 */
export function bindLogoutButtons(scope: ParentNode = document, logoutEndpoint?: string): void {
  const els = Array.from(scope.querySelectorAll<HTMLElement>("[data-logout]"));
  els.forEach((el) => {
    if ((el as any)._hype_loader_logout_bound) return;
    (el as any)._hype_loader_logout_bound = true;
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        const res = await logout(logoutEndpoint);
        if (res && (res as any).ok) {
          document.dispatchEvent(new CustomEvent("auth:logout", { detail: {} }));
        } else {
          console.warn("[client] logout failed", res);
        }
      } catch (err) {
        console.warn("[client] logout error", err);
      }
    });
  });
}

export default {
  fetchJson,
  getCsrfToken,
  login,
  logout,
  me,
  bindLoginForms,
  bindLogoutButtons,
};
