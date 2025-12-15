/**
 * src/plugins/auth.ts
 *
 * Auth plugin factory that accepts an injected client. This avoids importing
 * an application-level `client.ts` from core plugins and keeps the core
 * package unopinionated about network implementations.
 *
 * Usage:
 *   import { createAuthPlugin } from './plugins/auth';
 *   const plugin = createAuthPlugin(myClient);
 *   hype.attach(plugin);
 *
 * For backward compatibility a default `authPlugin` is exported which is a
 * no-op plugin (client-less). Consumers should prefer `createAuthPlugin`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal shape for an injected auth client. All fields are optional so the
 * plugin can be used with partial implementations in examples or host apps.
 */
export type AuthClient = Partial<{
  getCsrfToken: (endpoint?: string) => Promise<string | null>;
  login: (username: string, password: string, endpoint?: string) => Promise<any>;
  logout: (endpoint?: string) => Promise<any>;
  me: (endpoint?: string) => Promise<any>;
  bindLoginForm: (scope?: ParentNode, loginEndpoint?: string) => void;
  bindLogoutButtons: (scope?: ParentNode, logoutEndpoint?: string) => void;
}>;

/**
 * The shape of helpers we attach under `hype.auth`.
 */
export interface HypeAuthHelpers {
  getCsrfToken: (endpoint?: string) => Promise<string | null> | Promise<null>;
  login: (username: string, password: string) => Promise<any>;
  logout: () => Promise<any>;
  me: () => Promise<any>;
  bindLoginForm: (scope?: ParentNode) => void;
  bindLogoutButtons: (scope?: ParentNode) => void;
  autoBind?: () => void;
}

/**
 * Helper used to attach a non-enumerable property to the hype instance.
 */
function attachProp(obj: any, name: string, value: any) {
  try {
    Object.defineProperty(obj, name, {
      value,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  } catch {
    // fallback: best-effort assignment
    // eslint-disable-next-line no-param-reassign
    obj[name] = value;
  }
}

/**
 * Factory: create an auth plugin that delegates to the provided `client`.
 * If `client` is omitted the returned plugin is a no-op (safe default).
 *
 * install(hypeInstance) => optional cleanup function
 */
export function createAuthPlugin(client?: AuthClient) {
  return {
    install(hypeInstance: any) {
      if (!hypeInstance || typeof hypeInstance !== "object") return;

      // Avoid re-attaching if already present
      const already = (hypeInstance as any).auth;
      if (already) {
        // No-op, but return a cleanup that does nothing
        return () => {};
      }

      // Build helpers that delegate to the injected client if available.
      const helpers: HypeAuthHelpers = {
        getCsrfToken: async (endpoint?: string) => (client && client.getCsrfToken ? client.getCsrfToken(endpoint) : null),
        login: async (username: string, password: string) =>
          client && client.login ? client.login(username, password) : Promise.resolve({ ok: false }),
        logout: async () => (client && client.logout ? client.logout() : Promise.resolve({ ok: false })),
        me: async () => (client && client.me ? client.me() : Promise.resolve({ ok: false })),
        bindLoginForm: (scope?: ParentNode) => client && client.bindLoginForm && client.bindLoginForm(scope),
        bindLogoutButtons: (scope?: ParentNode) => client && client.bindLogoutButtons && client.bindLogoutButtons(scope),
        autoBind: () => {
          try {
            if (!client) return;
            if (typeof document !== "undefined") {
              client.bindLoginForm && client.bindLoginForm(document);
              client.bindLogoutButtons && client.bindLogoutButtons(document);
            }
          } catch (err) {
            // best-effort
            // eslint-disable-next-line no-console
            console.warn("hype:auth autoBind failed", err);
          }
        },
      };

      // Attach the helpers under a single `auth` namespace
      attachProp(hypeInstance, "auth", helpers);

      // Also attach convenience top-level methods `login`, `logout`, `me` on the instance
      // so consumers can call `hype.login(...)` if they prefer.
      attachProp(hypeInstance, "login", helpers.login);
      attachProp(hypeInstance, "logout", helpers.logout);
      attachProp(hypeInstance, "me", helpers.me);
      attachProp(hypeInstance, "getCsrfToken", helpers.getCsrfToken);
      attachProp(hypeInstance, "bindLoginForm", helpers.bindLoginForm);
      attachProp(hypeInstance, "bindLogoutButtons", helpers.bindLogoutButtons);

      // Optional: auto-bind login/logout forms present at install time if requested.
      // Hosts may toggle `hype.autoBindAuth = true` before attaching the plugin.
      if ((hypeInstance as any).autoBindAuth === true) {
        try {
          helpers.autoBind && helpers.autoBind();
        } catch {
          // ignore
        }
      }

      // Listen for DOM auth events and re-emit them on the hype instance where
      // possible. This provides a small bridge for apps that prefer `hype.on(...)`
      // style listeners (if the instance supports an EventSystem). We can't rely
      // on the internals of Hype, so simply forward DOM events onto the instance
      // by calling `hypeInstance.emit?.(...)` or using a lightweight adapter.
      const onAuthLogin = (ev: Event) => {
        try {
          if (typeof (hypeInstance as any).emit === "function") {
            (hypeInstance as any).emit("auth:login", ev);
          } else if ((hypeInstance as any).events) {
            const evsys = (hypeInstance as any).events;
            const detail = ev;
            try {
              if (typeof evsys.dispatch === "function") {
                evsys.dispatch(document as unknown as HTMLElement, "auth:login", detail);
              } else if (typeof evsys.emit === "function") {
                evsys.emit("auth:login", detail);
              }
            } catch {
              /* ignore event adapter failures */
            }
          }
        } catch {
          /* ignore forwarding errors */
        }
      };

      const onAuthLogout = (ev: Event) => {
        try {
          if (typeof (hypeInstance as any).emit === "function") {
            (hypeInstance as any).emit("auth:logout", ev);
          } else if ((hypeInstance as any).events) {
            const evsys = (hypeInstance as any).events;
            const detail = ev;
            try {
              if (typeof evsys.dispatch === "function") {
                evsys.dispatch(document as unknown as HTMLElement, "auth:logout", detail);
              } else if (typeof evsys.emit === "function") {
                evsys.emit("auth:logout", detail);
              }
            } catch {
              /* ignore event adapter failures */
            }
          }
        } catch {
          /* ignore */
        }
      };

      if (typeof document !== "undefined" && document && typeof document.addEventListener === "function") {
        document.addEventListener("auth:login", onAuthLogin);
        document.addEventListener("auth:logout", onAuthLogout);
      }

      // Return cleanup to remove attached props and listeners
      const cleanup = () => {
        try {
          // remove DOM listeners
          if (typeof document !== "undefined" && document && typeof document.removeEventListener === "function") {
            document.removeEventListener("auth:login", onAuthLogin);
            document.removeEventListener("auth:logout", onAuthLogout);
          }
        } catch {
          /* ignore */
        }

        try {
          delete (hypeInstance as any).auth;
        } catch {
          /* ignore */
        }
        try {
          delete (hypeInstance as any).login;
        } catch {
          /* ignore */
        }
        try {
          delete (hypeInstance as any).logout;
        } catch {
          /* ignore */
        }
        try {
          delete (hypeInstance as any).me;
        } catch {
          /* ignore */
        }
        try {
          delete (hypeInstance as any).getCsrfToken;
        } catch {
          /* ignore */
        }
        try {
          delete (hypeInstance as any).bindLoginForm;
        } catch {
          /* ignore */
        }
        try {
          delete (hypeInstance as any).bindLogoutButtons;
        } catch {
          /* ignore */
        }
      };

      return cleanup;
    },
  };
}

/**
 * Backwards-compatible default plugin export: no-op plugin (no client).
 * Consumers should prefer `createAuthPlugin(client)` so a client implementation
 * is explicitly provided by the host application.
 */
export const authPlugin = createAuthPlugin();
export default createAuthPlugin;
