/**
 * src/plugins/csrf.ts
 *
 * CSRF plugin for Hype.
 *
 * Automatically injects CSRF token as the `X-CSRFToken` header on
 * every mutating request (POST, PUT, PATCH, DELETE) so that `hype-post` and
 * other mutating attributes work out of the box with Django's CSRF middleware
 *
 *
 * Token resolution order (first non-empty value wins):
 *   1. `<meta name="csrf-token">` content attribute
 *      → set by Django's {% csrf_token %} or a custom meta tag in your base template
 *   2. `csrftoken` cookie
 *      → Django writes this cookie by default when CSRF middleware is active
 *   3. Static `token` string passed via options
 *      → escape hatch for SSR / test contexts where DOM / cookies are unavailable
 *
 * Usage — zero-config default (reads Django's standard meta tag / cookie):
 *
 *   import { csrfPlugin } from 'hype/plugins/csrf';
 *   hype.attach(csrfPlugin);
 *
 * Usage — customised:
 *
 *   import { createCsrfPlugin } from 'hype/plugins/csrf';
 *   hype.attach(createCsrfPlugin({
 *     metaSelector: 'meta[name="x-csrftoken"]',
 *     cookieName:   'csrftoken',
 *   }));
 *
 * In the browser IIFE build the plugin is exposed on the global `Hype` object:
 *
 *   <script>
 *     document.addEventListener('DOMContentLoaded', function () {
 *       if (window.hype && window.Hype?.csrfPlugin) {
 *         window.hype.attach(window.Hype.csrfPlugin);
 *       }
 *     });
 *   </script>
 */

import type { RequestContext } from "../types";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface CsrfPluginOptions {
  /**
   * CSS selector for the `<meta>` tag that carries the CSRF token.
   * Django convention: `<meta name="csrf-token" content="{{ csrf_token }}">`.
   * Default: `'meta[name="csrf-token"]'`
   */
  metaSelector?: string;

  /**
   * Name of the cookie Django stores the CSRF token in.
   * Default: `'csrftoken'`  (Django's out-of-the-box default)
   */
  cookieName?: string;

  /**
   * Optional static token string.
   * Takes precedence over meta-tag and cookie resolution when set.
   * Useful in server-side rendering or test environments.
   */
  token?: string;

  /**
   * HTTP methods that require the CSRF header.
   * Default: `['POST', 'PUT', 'PATCH', 'DELETE']`
   */
  methods?: string[];

  /**
   * Name of the request header to send the token in.
   * Default: `'X-CSRFToken'`  (Django's expected header name)
   */
  headerName?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const DEFAULT_META_SELECTOR = 'meta[name="csrf-token"]';
const DEFAULT_COOKIE_NAME = "csrftoken";
const DEFAULT_HEADER_NAME = "X-CSRFToken";

/**
 * Read a cookie value by name.
 * Returns `null` when the cookie is absent or when running outside a browser.
 */
function readCookie(name: string): string | null {
  if (typeof document === "undefined" || !document.cookie) return null;

  // Cookies are semicolon-separated; values may be URI-encoded.
  const match = document.cookie.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
  if (!match || match[1] === undefined) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1] as string;
  }
}

/**
 * Resolve the CSRF token using the configured sources.
 *
 * Resolution order:
 *   static option → meta tag → cookie
 */
function resolveToken(opts: CsrfPluginOptions): string | null {
  // 1. Static override (useful in tests / SSR)
  if (opts.token) return opts.token;

  if (typeof document === "undefined") return null;

  // 2. <meta name="csrf-token" content="...">
  const selector = opts.metaSelector ?? DEFAULT_META_SELECTOR;
  const meta = document.querySelector<HTMLMetaElement>(selector);
  if (meta?.content) return meta.content;

  // 3. csrftoken cookie
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE_NAME;
  return readCookie(cookieName);
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create a CSRF plugin with the provided options.
 *
 * The returned object conforms to Hype's plugin interface:
 * `{ install(hypeInstance): () => void }`
 */
export function createCsrfPlugin(options: CsrfPluginOptions = {}) {
  const methodSet = new Set((options.methods ?? DEFAULT_MUTATING_METHODS).map((m) => m.toUpperCase()));
  const headerName = options.headerName ?? DEFAULT_HEADER_NAME;

  return {
    install(hypeInstance: unknown) {
      if (!hypeInstance || typeof (hypeInstance as Record<string, unknown>).onRequest !== "function") {
        if (typeof console !== "undefined") {
          console.warn("[hype:csrf] Plugin installed on an instance that does not support " + "`onRequest`. CSRF tokens will NOT be injected. ");
        }
        return;
      }

      const h = hypeInstance as { onRequest: (fn: (ctx: RequestContext) => RequestContext) => () => void };

      const removeInterceptor = h.onRequest((ctx: RequestContext) => {
        // Only inject on mutating methods — GET / HEAD / OPTIONS are safe
        if (!methodSet.has(String(ctx.method).toUpperCase())) return ctx;

        const token = resolveToken(options);
        if (!token) return ctx;

        // ctx.init.headers is always a plain Record<string, string> as built
        // by Hype's buildInit() — safe to treat as a mutable string map.
        if (ctx.init?.headers) {
          (ctx.init.headers as Record<string, string>)[headerName] = token;
        }

        return ctx;
      });

      // Return the cleanup function so Hype can deregister the interceptor
      // when the plugin is uninstalled (e.g. hype.destroy()).
      return typeof removeInterceptor === "function" ? removeInterceptor : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

/**
 * Ready-to-use default instance.
 * Reads Django's standard `<meta name="csrf-token">` tag, falls back to the
 * `csrftoken` cookie, and injects `X-CSRFToken` on POST / PUT / PATCH / DELETE.
 *
 * @example
 *   hype.attach(csrfPlugin);
 */
export const csrfPlugin = createCsrfPlugin();

export default createCsrfPlugin;
