/**
 * src/plugins/auth.ts
 *
 * A small auth plugin that wires simple client auth helpers onto a Hype
 * instance. The plugin attaches non-enumerable properties so consumers can
 * opt-in to using `hype.auth` or calling `hype.login(...)`, `hype.logout()`, etc.
 *
 * The plugin intentionally is lightweight:
 *  - It re-uses the shared client helpers in `src/client.ts`.
 *  - It does not change Hype internals or automatically add request
 *    interceptors (that can be added later if desired).
 *
 * Usage:
 *   import { hype, authPlugin } from './hype';
 *   hype.attach(authPlugin);
 *
 * After attaching:
 *   hype.auth.login(username,password)
 *   await hype.login(username,password)   // shortcut
 *
 * The plugin returns a cleanup function that removes the attached properties.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getCsrfToken as clientGetCsrfToken,
  login as clientLogin,
  logout as clientLogout,
  me as clientMe,
  bindLoginForms as clientBindLoginForms,
  bindLogoutButtons as clientBindLogoutButtons,
} from "../client";

/**
 * The shape of helpers we attach under `hype.auth`.
 */
export interface HypeAuthHelpers {
  getCsrfToken: (endpoint?: string) => Promise<string | null>;
  login: (username: string, password: string, endpoint?: string) => Promise<any>;
  logout: (endpoint?: string) => Promise<any>;
  me: (endpoint?: string) => Promise<any>;
  bindLoginForms: (scope?: ParentNode, loginEndpoint?: string) => void;
  bindLogoutButtons: (scope?: ParentNode, logoutEndpoint?: string) => void;
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
 * Auth plugin adapter compatible with Hype's plugin install pattern.
 *
 * install(hypeInstance) => optional cleanup function
 */
export const authPlugin = {
  install(hypeInstance: any) {
    if (!hypeInstance || typeof hypeInstance !== "object") return;

    // Avoid re-attaching if already present
    const already = (hypeInstance as any).auth;
    if (already) {
      // No-op, but return a cleanup that does nothing
      return () => {};
    }

    const helpers: HypeAuthHelpers = {
      getCsrfToken: (endpoint?: string) => clientGetCsrfToken(endpoint),
      login: (username: string, password: string, endpoint?: string) =>
        clientLogin(username, password, endpoint),
      logout: (endpoint?: string) => clientLogout(endpoint),
      me: (endpoint?: string) => clientMe(endpoint),
      bindLoginForms: (scope?: ParentNode, loginEndpoint?: string) =>
        clientBindLoginForms(scope, loginEndpoint),
      bindLogoutButtons: (scope?: ParentNode, logoutEndpoint?: string) =>
        clientBindLogoutButtons(scope, logoutEndpoint),
      autoBind: () => {
        try {
          if (typeof document !== "undefined") {
            clientBindLoginForms(document);
            clientBindLogoutButtons(document);
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
    attachProp(hypeInstance, "bindLoginForms", helpers.bindLoginForms);
    attachProp(hypeInstance, "bindLogoutButtons", helpers.bindLogoutButtons);

    // Optional: auto-bind login/logout forms present at install time.
    // Keep this opt-in by only doing it when `hypeInstance.getConfig` exists and
    // debug is false? For simplicity make it opt-out via a property on the instance.
    // If the host sets `hype.autoBindAuth = true` prior to attach, do autoBind.
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
    // by calling `hypeInstance.emit?.(...)` or setting a lightweight handler.
    const onAuthLogin = (ev: Event) => {
      try {
        // try a common pattern: if instance has `events` or `emit` call it
        if (typeof (hypeInstance as any).emit === "function") {
          (hypeInstance as any).emit("auth:login", ev);
        } else if (typeof (hypeInstance as any).events?.emit === "function") {
          (hypeInstance as any).events.emit("auth:login", ev);
        }
      } catch {
        /* ignore forwarding errors */
      }
    };
    const onAuthLogout = (ev: Event) => {
      try {
        if (typeof (hypeInstance as any).emit === "function") {
          (hypeInstance as any).emit("auth:logout", ev);
        } else if (typeof (hypeInstance as any).events?.emit === "function") {
          (hypeInstance as any).events.emit("auth:logout", ev);
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
        delete (hypeInstance as any).bindLoginForms;
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

export default authPlugin;
