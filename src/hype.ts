import type {
  HypeConfig,
  HttpMethod,
  SwapStrategy,
  RequestContext,
  ResponseContext,
  HypeJsonResponse,
  RequestInterceptor,
  ResponseInterceptor,
  SwapHandler,
  ValidationFn,
  HypeElement,
  HypeAttributes,
} from "./types";
import type { IEventSystem } from "./interfaces/event-system.interface";
import type { IRendererHost } from "./interfaces/renderer-host.interface";
import { createEventSystem } from "./events";
import { InterceptorRegistry, defaultSwap } from "./interceptors";
import { ReactiveSystem } from "./reactive";
import {
  serializeForm,
  formDataToParams,
  mergeValues,
  getSubmitButton,
  includeSubmitButton,
  validateFormHTML5,
  reportValidity,
  getFormMethod,
  getFormAction,
  prepareRequestBody,
} from "./form";
// Small DI-friendly interfaces for network and transport
import type { Fetcher } from "./interfaces/fetcher";
import { defaultFetcher } from "./interfaces/fetcher";
import type { PubSubTransport } from "./interfaces/transport";
import { NoopTransport, createWebSocketTransport } from "./interfaces/transport";
// Plugins (optional): pubsub & behavior registry (exposed as plugins)
import { pubsubPlugin } from "./plugins/pubsub";
import { behaviorPlugin } from "./plugins/behavior";
import { authPlugin } from "./plugins/auth";

/**
 * Default configuration
 */
const DEFAULT_CONFIG: HypeConfig = {
  // Safer-by-default: Hype uses `innerText` as the default swap to avoid unsafe HTML injection.
  // If a consumer (or tests) require `innerHTML`, explicitly opt-in via configuration:
  //   createHype({ defaultSwap: 'innerHTML' })
  // At runtime Hype still blocks unsafe `innerHTML` swaps unless explicitly allowed by:
  //  - the element explicitly requesting `hype-swap="innerHTML"` (author opt-in), or
  //  - the server setting header `X-Hype-Allow-InnerHTML: true`, or
  //  - a JSON response including `allowInnerHTML: true`.
  defaultSwap: "innerText",
  settleDelay: 20,
  timeout: 30000,
  credentials: "same-origin",
  headers: {
    "X-Requested-With": "XMLHttpRequest",
  },
  throwOnHttpError: false,
  dedupe: "cancel",
  history: false,
  attributePrefix: "hype",
  debug: false,
  // Default plugin toggles: control convenience plugins attached during `init()`.
  // Plugins are JS-only: HTML remains valid and functional without JavaScript.
  // Consumers can override via createHype({ plugins: { pubsub: false, behavior: false, auth: false } })
  plugins: {
    pubsub: true,
    behavior: true,
    debounce: true,
    auth: true,
  },
};

/**
 * Hype - A minimal progressive-enhancement fetch enhancer
 *
 * @example
 * ```html
 * <!-- Progressive enhancement: works without JavaScript; when JS is present Hype wires unobtrusive AJAX behavior -->
 * <form hype-post="/api/submit" hype-target="#result" hype-swap="innerHTML">
 *   <input name="email" type="email" required>
 *   <button type="submit">Submit</button>
 * </form>
 * <div id="result"></div>
 * ```
 */

/*
 *
 * Hype accepts atm a single optional IEventSystem
 * instance via the constructor. subsystems (interceptors, reactive)
 * are created internally by Hype.
 */

export class Hype {
  private config: HypeConfig;
  private events: IEventSystem;
  private interceptors: InterceptorRegistry;
  private reactive: ReactiveSystem;
  private attrs: HypeAttributes;
  private observer: MutationObserver | null = null;
  // Bound event handler references so we can remove listeners reliably on destroy/unmount.
  // Using stored bound references avoids the common bug of passing .bind(this) twice
  // which creates distinct functions and prevents removal.
  private _boundHandleSubmit?: EventListenerOrEventListenerObject;
  private _boundHandleClick?: EventListenerOrEventListenerObject;

  // cleanup functions returned by attached plugins (if plugin returns a teardown)
  private _attachedPluginCleanups: Array<() => void> = [];

  // MutationObserver used to watch for `data-hype-active-index` changes (snap behavior).
  // Hype will update optional UI targets when behaviors set this attribute.
  private _activeIndexObserver: MutationObserver | null = null;

  // Root element that Hype is mounted to. Mounting a root is required and immutable:
  // - The runtime must be mounted to a single element which becomes the Hype sandbox.
  // - Once mounted, the root cannot be changed for security and determinism.
  private rootElement: Element | null = null;
  private mounted: boolean = false;
  private initialized = false;
  // Preferred public start entrypoint.
  // Implemented to delegate to the legacy `init()` implementation while
  // suppressing the deprecation warning (run() is the recommended API).
  private _suppressInitWarning: boolean = false;
  public run(plugins?: unknown | unknown[], opts: { scan?: boolean | "idle" } = { scan: "idle" }): void {
    // Canonical start entrypoint. Call the concrete init implementation directly
    // (avoid 'any' casts). We keep the one-time suppressed warning behavior.
    this._suppressInitWarning = true;
    try {
      this.init(plugins, opts);
    } finally {
      this._suppressInitWarning = false;
    }
  }

  // Optional renderer/host adapter. This will be populated when a rendererHost is
  // provided to the constructor or factory. Typed as `IRendererHost`.
  private rendererHost?: IRendererHost;

  // Networking & transport abstractions (injected via factory)
  // - `fetch` is a Fetcher-compatible function used by runtime and plugins.
  // - `transport` implements PubSubTransport for pub/sub semantics.
  // - `pub` is a small facade for publishing to the transport.
  // - `onRemote` is a convenience wrapper for subscribing to remote topics.
  public fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  public transport: PubSubTransport = NoopTransport;
  public pub: (topic: string, payload?: any) => void = () => {};
  public onRemote: (topic: string, handler: (payload: any) => void) => { unsubscribe(): void } = () => ({ unsubscribe() {} });

  // remote schemas storage removed (unused)

  /**
   * Create a Hype instance.
   *
   * - `config` provides runtime configuration.
   * - `events` optionally supplies an event system implementation (IoC).
   * - `host` optionally supplies a renderer/host adapter (DOM by default).
   *
   * The constructor keeps the rest of the subsystems internal to keep the API
   * small and opinionated. Consumers who need to swap more pieces can still
   * replace them via dedicated factories in future refactors.
   *
   * Note: `host` is typed as `any` for now to avoid introducing a direct type
   * import in this minimal change. Subsequent commits should replace `any` with
   * the `IRendererHost` interface from the new interfaces file.
   */
  constructor(config: Partial<HypeConfig> = {}, events?: IEventSystem, rendererHost?: IRendererHost) {
    // Merge defaults then validate attributePrefix
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Normalize attributePrefix to a base (strip leading 'data-' if present) and ensure non-empty.
    try {
      let ap = (this.config as any).attributePrefix;
      if (typeof ap !== 'string' || !ap || !ap.length) {
        ap = DEFAULT_CONFIG.attributePrefix;
      }
      // If consumer passed a `data-` prefixed value, normalize to the base name.
      if (ap.startsWith('data-')) {
        ap = ap.slice(5);
      }
      (this.config as any).attributePrefix = ap;
    } catch {
      (this.config as any).attributePrefix = DEFAULT_CONFIG.attributePrefix;
    }

    // Use injected event system or default factory.
    this.events = events ?? createEventSystem(this.config.debug);

    // Store provided renderer host for later use by systems that need to access the host.
    // If no rendererHost is provided here we'll let subsystems decide their fallback
    // behavior for now; later refactors will provide a DefaultDomHost fallback.
    this.rendererHost = rendererHost;

    // Initialize network & transport defaults (DIP-friendly defaults). These
    // are conservative defaults that can be overridden by the factory `createHype`
    // via dependency injection.
    // Prefer strongly-typed fields on the instance (no `any` casts).
    try {
      // defaultFetcher is the safe global fetch delegate; transports default to NoopTransport.
      this.fetch = defaultFetcher;
    } catch {
      // defensive: environments without global fetch will fallback at call site
      this.fetch = undefined;
    }
    try {
      this.transport = NoopTransport;
    } catch {
      this.transport = NoopTransport;
    }

    // Provide small facades bound to this instance for convenience.
    this.pub = (topic: string, payload?: any) => {
      try {
        this.transport?.publish(topic, payload);
      } catch {
        /* swallow publish errors */
      }
    };
    this.onRemote = (topic: string, handler: (payload: any) => void) => {
      try {
        return this.transport?.subscribe(topic, handler) ?? { unsubscribe() {} };
      } catch {
        return { unsubscribe() {} };
      }
    };

    // Create other subsystems internally for a simpler public API.
    this.interceptors = new InterceptorRegistry();
    this.reactive = new ReactiveSystem(this.config);

    this.attrs = this.createAttributes(this.config.attributePrefix);

    // Apply debug setting to the event system; if setDebug exists it will be called.
    try {
      // IEventSystem implementations should expose setDebug.
      this.events.setDebug?.(this.config.debug);
    } catch {
      /* ignore debug forwarding errors */
    }
  }

  /**
   * Attach a plugin to this Hype instance.
   *
   * Plugin shapes supported:
   *  - function(hype) { ... }         // will be called with this instance
   *  - { install(hype) { ... } }      // will call install(hype)
   *
   * If the plugin returns a cleanup function, it will be stored and invoked on destroy().
   *
   * Examples:
   *   hype.attach(pubsubPlugin);
   *   hype.attach(function (h) { h.sub(...); return () => { ... } });
   */
  public applySocketMessage(msg: any): void {
    // Conservative, typed implementation for handling simple server push shapes.
    // Supports: { type: 'snapshot'|'patch'|'event', target, html, schema, topic, payload }
    try {
      if (!msg || typeof msg !== "object") return;
      const type: string | undefined = msg.type;
      const targetSel = msg.target;
      const html: string | undefined = msg.html;
      const payload = msg.payload;

      const target =
        typeof targetSel === "string"
          ? document.querySelector(targetSel)
          : targetSel instanceof Element
          ? targetSel
          : null;

      switch (type) {
        case "snapshot":
          if (!target) return;
          (target as HTMLElement).innerHTML = html ?? "";

          // Re-scan bindings if runtime exposes scan()
          try {
            this.scan?.(target as Element);
          } catch {}
          return;

        case "patch":
          if (!target) return;
          if (html != null) {
            (target as HTMLElement).innerHTML = html;
            try {
              this.scan?.(target as Element);
            } catch {}
          } else if (payload) {
            // schema-driven patches removed; fallback placeholder
          }
          return;

        case "event":
          if (typeof this.pub === "function" && typeof msg.topic === "string") {
            try {
              this.pub(msg.topic, payload);
            } catch {}
          }
          return;

        default:
          // allow user override
          if (typeof (this as any).onSocketMessage === "function") {
            try {
              (this as any).onSocketMessage(msg);
            } catch {}
          }
          return;
      }
    } catch {
      /* swallow apply errors */
    }
  }

  attach(plugin: unknown): void {
    if (!plugin) return;
    try {
      // If plugin is a function, call it with the instance
      if (typeof plugin === "function") {
        const maybeCleanup = (plugin as Function)(this);
        if (typeof maybeCleanup === "function") {
          this._attachedPluginCleanups.push(maybeCleanup as () => void);
        }
        return;
      }

      // If plugin is an object with install, call install
      const p = plugin as { install?: (h: Hype) => any };
      if (p && typeof p.install === "function") {
        const maybeCleanup = p.install(this as unknown as Hype);
        if (typeof maybeCleanup === "function") {
          this._attachedPluginCleanups.push(maybeCleanup as () => void);
        }
        return;
      }
    } catch (err) {
      // Do not blow up attach; surface to console in debug mode
      // eslint-disable-next-line no-console
      if (this.config?.debug) console.warn("Hype: plugin attach failed", err);
    }
  }

  /**
   * Create attribute names based on prefix
   */
  private createAttributes(prefix: string): HypeAttributes {
    // Use plain prefix-based attribute names (no automatic `data-` prefix) so
    // consumers can opt to author attributes either as `hype-post` or as
    // `data-hype-post` if they prefer. The runtime looks up the exact name
    // returned here when querying attributes.
    return {
      get: `${prefix}-get`,
      post: `${prefix}-post`,
      put: `${prefix}-put`,
      delete: `${prefix}-delete`,
      patch: `${prefix}-patch`,
      target: `${prefix}-target`,
      swap: `${prefix}-swap`,
      trigger: `${prefix}-trigger`,
      confirm: `${prefix}-confirm`,
      validate: `${prefix}-validate`,
      indicator: `${prefix}-indicator`,
      disabled: `${prefix}-disabled-elt`,
      headers: `${prefix}-headers`,
      vals: `${prefix}-vals`,
      encoding: `${prefix}-encoding`,
      push: `${prefix}-push-url`,
      boost: `${prefix}-boost`,
    };
  }

  /**
   * Public helper: clone a template and interpolate {{keys}} with provided data.
   *
   * Usage: `hype.templateClone('#photo-tpl', { src: '...', alt: '...' })`
   *
   * Returns an Element (first top-level node) or DocumentFragment or null.
   */
  public templateClone(selectorOrElement: string | HTMLTemplateElement, data: Record<string, any> = {}): Element | DocumentFragment | null {
    try {
      const tpl = typeof selectorOrElement === "string" ? (document.querySelector(selectorOrElement) as HTMLTemplateElement | null) : selectorOrElement;
      if (!tpl || !(tpl instanceof HTMLTemplateElement)) return null;
      const frag = tpl.content.cloneNode(true) as DocumentFragment;

      const interpolate = (str: string) =>
        String(str).replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_m, key) => {
          const parts = key.split(".");
          let v: any = data;
          for (const p of parts) {
            if (v == null) return "";
            v = v[p];
          }
          return v == null ? "" : String(v);
        });

      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          node.textContent = interpolate(node.textContent || "");
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        for (const attr of Array.from(el.attributes || [])) {
          const replaced = interpolate(attr.value);
          if (replaced !== attr.value) el.setAttribute(attr.name, replaced);
        }
        for (const child of Array.from(el.childNodes || [])) walk(child);
      };

      for (const n of Array.from(frag.childNodes)) walk(n);
      return frag.firstElementChild ? frag.firstElementChild : frag;
    } catch (err) {
      if (this.config?.debug) console.warn("hype.templateClone failed", err);
      return null;
    }
  }

  /**
   * Compute a tagged fingerprint for a given string.
   *
   * Returns a string in the form "<ALG>:<hex>", where ALG indicates the
   * algorithm used (for example "FNV1A64" or "FNV1A32"). The runtime attempts
   * a 64-bit FNV-1a implementation using BigInt/TextEncoder when available,
   * and falls back to a deterministic 32-bit FNV-1a otherwise. SHA-256 is
   * cryptographically stronger; switch to it on both client and server if
   * you need collision resistance or security guarantees.
   */
  private async computeFingerprint(input: string, opts?: { algorithm?: 'fnv1a64' | 'fnv1a32' }): Promise<string> {
    const desired = (opts && opts.algorithm) || 'fnv1a64';
    const s = typeof input === "string" ? input : String(input ?? "");

    // Prefer BigInt/TextEncoder path for 64-bit FNV-1a when requested.
    if (desired === 'fnv1a64') {
      try {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(s);
        const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
        const FNV_PRIME_64 = 0x100000001b3n;
        let hash = FNV_OFFSET_BASIS_64;
        for (const byte of bytes) {
          hash ^= BigInt(byte);
          hash = (hash * FNV_PRIME_64) & 0xffffffffffffffffn;
        }
        return "FNV1A64:" + hash.toString(16).padStart(16, "0");
      } catch {
        // If BigInt/TextEncoder isn't available, fall through to 32-bit fallback.
      }
    }

    // 32-bit FNV-1a fallback (deterministic, widely available).
    try {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return "FNV1A32:" + (h >>> 0).toString(16).padStart(8, "0");
    } catch {
      return "";
    }
  }

  /**
   * Parse a tagged fingerprint value into its algorithm and hex/value parts.
   *
   * Examples:
   *   - "FNV1A64:00ab..." -> { alg: "FNV1A64", value: "00ab..." }
   *   - "FNV1A32:abcd1234" -> { alg: "FNV1A32", value: "abcd1234" }
   *   - "abcdef" -> { alg: undefined, value: "abcdef" }
   */
  private parseFingerprintTag(fp: string | null | undefined): { alg?: string; value?: string } {
    if (!fp || typeof fp !== "string") return {};
    const idx = fp.indexOf(":");
    if (idx === -1) {
      return { value: fp };
    }
    return { alg: fp.slice(0, idx), value: fp.slice(idx + 1) };
  }

  /**
   * Initialize Hype on the document and optionally attach plugins.
   *
   * You may pass a single plugin or an array of plugins. Each plugin will be
   * passed to `this.attach(plugin)` for installation.
   *
   * Examples:
   *   hype.init();
   *   hype.init(pubsubPlugin);
   *   hype.init([pubsubPlugin, analyticsPlugin]);
   *
   * Plugins may be functions or objects with an `install` method. If a plugin
   * returns a cleanup function, Hype will call it on `destroy()`.
   */
  init(plugins?: unknown | unknown[], opts: { scan?: boolean | "idle" } = { scan: "idle" }): void {
    // If already initialized, no-op.
    if (this.initialized) {
      return;
    }

    // Deprecation notice:
    // `init()` is deprecated. Prefer `run()` as the canonical start method for
    // Hype. During the deprecation period calling `init()` will emit a single
    // console warning encouraging callers to switch to `run()`.
    if (!this._suppressInitWarning) {
      // eslint-disable-next-line no-console
      console.warn("hype.init() is deprecated. Use hype.run() instead. `init()` will be removed in a future release.");
    }

    this.log("Initializing Hype");

    // If plugins were provided on init, attach them first so they can hook before wiring
    if (plugins) {
      const list = Array.isArray(plugins) ? plugins : [plugins];
      for (const p of list) {
        this.attach(p);
      }
    }

    // Set up event delegation (synchronous, cheap)
    // Store the bound handler references so they can be removed by destroy()/unmount().
    this._boundHandleSubmit = this.handleSubmit.bind(this);
    this._boundHandleClick = this.handleClick.bind(this);
    document.addEventListener("submit", this._boundHandleSubmit, true);
    document.addEventListener("click", this._boundHandleClick, true);

    // Attach default convenience plugins (still modular and optional).
    // These are installed via the plugin API so consumers can opt-out, replace,
    // or attach different implementations via `hype.attach(...)` or by passing
    // plugins into `hype.init(...)`.
    // Plugins are JS-only (progressive enhancement): HTML remains valid without them.
    // Respect runtime configuration `this.config.plugins` which can disable defaults.
    const pluginsCfg = this.config && this.config.plugins ? this.config.plugins : { pubsub: true, behavior: true, debounce: true };
    if (pluginsCfg.pubsub !== false) {
      try {
        // Pub/sub is attached automatically when enabled so JS consumers
        // get `hype.pub` / `hype.sub` by default.
        this.attach(pubsubPlugin);
      } catch (e) {
        if (this.config.debug) console.warn("Hype: failed to attach pubsub plugin", e);
      }
    }
    if (pluginsCfg.behavior !== false) {
      try {
        this.attach(behaviorPlugin);
      } catch (e) {
        if (this.config.debug) console.warn("Hype: failed to attach behavior plugin", e);
      }
    }

    // Optional auth plugin: attaches convenience auth helpers (hype.auth, hype.login, etc.)
    // Enabled by default in DEFAULT_CONFIG.plugins.auth, consumers can disable via config.
    if ((pluginsCfg as any).auth !== false) {
      try {
        this.attach(authPlugin);
      } catch (e) {
        if (this.config.debug) console.warn("Hype: failed to attach auth plugin", e);
      }
    }

    // Expose the instance on window for behavior implementations that rely on a global helper.
    // This keeps backward compatibility with examples that reference `window.hype.templateClone`.
    try {
      if (typeof window !== "undefined") {
        // Avoid `any` by using a narrow, local typing for the global helper.
        (window as unknown as { hype?: Hype }).hype = this;
      }
    } catch {
      /* ignore non-browser environments */
    }

    // Prepare a deferred scan that performs heavier DOM wiring. The scan can be
    // executed immediately, scheduled on requestIdleCallback, or skipped.
    const doScan = () => {
      try {
        // Initialize reactive system on document body
        this.reactive.init(document.body);
      } catch {
        /* ignore reactive init errors */
      }

      // Set up mutation observer for dynamically added elements
      try {
        this.observer = new MutationObserver(this.handleMutations.bind(this));
        this.observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
      } catch {
        /* ignore */
      }

      // Observe `data-hype-active-index` attribute changes so examples can reflect snap active index.
      // Containers using the snap behavior may set `data-hype-active-index`; to display it,
      // authors may include a child with `data-hype-active-display` on the container pointing
      // to a selector (or include an element with id="activeIdx" inside the container for simple demos).
      try {
        this._activeIndexObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type !== "attributes") continue;
            const target = m.target as HTMLElement;
            if (!target) continue;
            const newVal = target.getAttribute("data-hype-active-index");
            // prefer explicit selector on container
            const displaySelector = target.getAttribute("data-hype-active-display");
            if (displaySelector) {
              try {
                const disp = document.querySelector(displaySelector) as HTMLElement | null;
                if (disp) disp.textContent = newVal ?? "";
                continue;
              } catch {
                /* ignore */
              }
            }
            // fallback: find an element inside the container with id 'activeIdx'
            try {
              const fallback = target.querySelector("#activeIdx") as HTMLElement | null;
              if (fallback) fallback.textContent = newVal ?? "";
            } catch {
              /* ignore */
            }
          }
        });
        this._activeIndexObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-hype-active-index"] });
      } catch {
        /* ignore observer errors */
      }
    };

    // Mark as initialized immediately to avoid re-entrancy; the heavier DOM scan will
    // occur asynchronously per opts (scan=true -> immediate, scan='idle' -> idle, false -> skip).
    this.initialized = true;

    // Provide a runtime alias `run` on the instance that callers can use as the
    // canonical runtime start method. We bind to `init` for backward compatibility.
    // Declared as a public property above so TypeScript consumers see it.
    try {
      // `run` is provided as a public method — no runtime rebinding required.
      // We intentionally avoid creating dynamic aliases that rely on `any`.
    } catch {
      /* ignore binding errors in non-browser environments */
    }

    // Decide how to run the scan based on opts
    const scanOpt = opts && typeof opts.scan !== "undefined" ? opts.scan : "idle";
    if (scanOpt === "idle") {
      // Schedule on requestIdleCallback when available with a short timeout, fallback to setTimeout.
      try {
        const ric = (window as any).requestIdleCallback;
        if (typeof ric === "function") {
          ric(() => {
            try {
              doScan();
            } catch {
              /* ignore scan errors */
            }
          }, { timeout: 200 });
        } else {
          // Fallback small delay
          setTimeout(() => {
            try {
              doScan();
            } catch {
              /* ignore scan errors */
            }
          }, 50);
        }
      } catch {
        // Unexpected environment, fallback to timeout
        setTimeout(() => {
          try {
            doScan();
          } catch {
            /* ignore scan errors */
          }
        }, 50);
      }
    } else if (scanOpt === true) {
      // Immediate (synchronous) scan — kept for backward-compatibility but not recommended for large pages.
      try {
        doScan();
      } catch {
        /* ignore scan errors */
      }
    } else {
      // scanOpt === false -> skip the DOM scan and observer setup
      // The instance is initialized but heavy DOM wiring is intentionally deferred/disabled.
    }
  }
  
  /**
   * Public convenience: perform a reactive scan (bootstrap) on the mounted root or a provided element.
   *
   * - Mounting a root via `hype.mount(rootElement)` is mandatory before calling `init()` or `scan()`.
   * - The mounted root is immutable once set. This enforces a sandboxed scope for Hype wiring.
   *
   * Usage:
   *   // after mounting:
   *   hype.mount(document.querySelector('#hype-root'));
   *   hype.init(); // safe, non-blocking by default
   *
   *   // or scan a specific element within the mounted root (explicit)
   *   hype.scan('#widget-1');
   */
  public scan(selectorOrEl?: string | Element): void {
    if (!this.mounted || !this.rootElement) {
      throw new Error("Hype.scan() requires a mounted root. Call hype.mount(rootElement) before scanning.");
    }

    let target: Element | null = null;
    if (!selectorOrEl) {
      target = this.rootElement;
    } else if (typeof selectorOrEl === "string") {
      try {
        // Query relative to the mounted root for containment and security.
        target = (this.rootElement as Element).querySelector(selectorOrEl);
      } catch {
        target = null;
      }
    } else if ((selectorOrEl as Element).nodeType) {
      // Ensure the provided element is contained within the mounted root.
      const el = selectorOrEl as Element;
      if (this.rootElement.contains(el)) {
        target = el;
      } else {
        if (this.config?.debug) {
          // eslint-disable-next-line no-console
          console.warn("[Hype.scan] provided element is not contained within the mounted root; skipping.");
        }
        target = null;
      }
    }

    if (!target) {
      if (this.config?.debug) {
        // eslint-disable-next-line no-console
        console.warn("[Hype.scan] No valid target found for scan within the mounted root; skipping.");
      }
      return;
    }

    // Delegate to reactive subsystem to perform attribute wiring for the subtree rooted at `target`.
    try {
      // Prefer a rendererHost-resolved root when a host adapter is present. This allows
      // non-DOM hosts to determine the appropriate element/document mapping.
      const initTarget = this.rendererHost && typeof this.rendererHost.resolveRoot === "function"
        ? ((this.rendererHost.resolveRoot(target as any) as HTMLElement) ?? (target as HTMLElement))
        : (target as HTMLElement);

      (this.reactive as any).init(initTarget as HTMLElement);
    } catch (err) {
      if (this.config?.debug) {
        // eslint-disable-next-line no-console
        console.warn("[Hype.scan] reactive.init failed for target:", target, err);
      }
    }
  }

  /**
   * Mount the runtime to a single root element. Mounting is mandatory and immutable.
   *
   * - root may be an Element or a selector string (resolved against document).
   * - Once mounted, subsequent mount() calls are ignored and an error is thrown in strict mode.
   */
  public mount(root: Element | string): void {
    if (this.mounted) {
      // Immutable: do not allow changing the root once set.
      throw new Error("Hype.mount() has already been called. The mount root is immutable for security reasons.");
    }
    let resolved: Element | null = null;

    // If a rendererHost adapter is present, prefer rendererHost.resolveRoot which can support
    // non-DOM hosts or alternate resolution semantics.
    if (this.rendererHost && typeof this.rendererHost.resolveRoot === "function") {
      try {
        const maybe = this.rendererHost.resolveRoot(root as any);
        if (maybe) {
          // If host returned a Document, normalize to its documentElement so mount
          // remains an Element. Otherwise accept the Element as-is.
          if ((maybe as Document).nodeType === 9) {
            resolved = (maybe as Document).documentElement ?? null;
          } else if ((maybe as Element).nodeType) {
            resolved = maybe as Element;
          } else {
            resolved = null;
          }
        } else {
          resolved = null;
        }
      } catch {
        resolved = null;
      }
    } else {
      // Fallback to DOM resolution when no host is injected.
      if (typeof root === "string") {
        try {
          resolved = document.querySelector(root);
        } catch {
          resolved = null;
        }
      } else if ((root as Element).nodeType) {
        resolved = root as Element;
      }
    }

    if (!resolved) {
      throw new Error("Hype.mount() could not resolve the provided root. Provide a valid Element or selector.");
    }

    this.rootElement = resolved;
    this.mounted = true;
    if (this.config?.debug) {
      // eslint-disable-next-line no-console
      console.info("[Hype.mount] mounted to root:", resolved);
    }
  }
  
  /**
   * Deferred autowire helper.
   *
   * Dynamically imports optional plugin factories when DOM markers indicate they are needed.
   * This prevents hard-wiring optional UI plugins into the core runtime and keeps Hype minimal.
   *
   * Usage (composition root / demo):
   *   // Let Hype inspect the DOM and attach optional plugins lazily:
   *   await hype.autowirePlugins();
   *
   * Options:
   *   { crud: false }                   // disable autowire for crud
   *   { crud: { endpoint: '/api/items' } // pass config to crud factory
   */
  public async autowirePlugins(): Promise<void> {
    // NOTE: As of the recent refactor the optional CRUD/UI plugins have been
    // moved out of the main runtime surface into the repository's experimental
    // area. This prevents the core runtime from implicitly importing
    // application/demo-level code which may not be present in consumer builds.
    //
    // Location: experimental/plugins/crud and experimental/plugins/ui
    //
    // Autowire is therefore disabled for those optional plugins by default.
    // Hosts that want to use the experimental plugins should explicitly attach
    // them after creating a Hype instance, for example:
    //
    //   import createCrudPlugin from '/path/to/experimental/plugins/crud';
    //   hype.attach(createCrudPlugin({ endpoint: '/api/items' }));
    //
    // Keep autowirePlugins available for future opt-in behavior, but do not
    // attempt dynamic imports of experimental modules from core.
    if (typeof document === "undefined") return;

    if (this.config?.debug) {
      // Informative hint for developers running in debug builds.
      // No attempt is made to resolve or import experimental plugins here.
      // See the repository's experimental/ directory for moved plugin sources.
      // (Autowire disabled to avoid build/test resolution errors.)
      // eslint-disable-next-line no-console
      console.debug("autowirePlugins: optional CRUD/UI plugins are experimental and not auto-imported. See experimental/plugins.");
    }

    // We intentionally do nothing further here. Consumers may opt into dynamic
    // wiring by calling `hype.attach(...)` with plugin factories from the
    // experimental location or from their own app-level modules.
    return;
  }

  /**
   * Unmount the runtime from its current root.
   *
   * This will stop mutation observers, remove delegated DOM listeners, and
   * clear the mounted root, but will NOT run plugin cleanup or clear
   * interceptors. Use `destroy()` for a full teardown.
   */
  public unmount(): void {
    if (!this.mounted) {
      return;
    }

    // Remove delegated event listeners if we registered bound handlers
    try {
      if (this._boundHandleSubmit) {
        try {
          document.removeEventListener("submit", this._boundHandleSubmit, true);
        } catch {
          /* ignore */
        }
        this._boundHandleSubmit = undefined;
      }
    } catch {
      /* ignore */
    }
    try {
      if (this._boundHandleClick) {
        try {
          document.removeEventListener("click", this._boundHandleClick, true);
        } catch {
          /* ignore */
        }
        this._boundHandleClick = undefined;
      }
    } catch {
      /* ignore */
    }

    // Disconnect primary mutation observer (used for dynamic wiring)
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch {
        /* ignore */
      }
      this.observer = null;
    }

    // Disconnect active-index observer if present
    if (this._activeIndexObserver) {
      try {
        this._activeIndexObserver.disconnect();
      } catch {
        /* ignore */
      }
      this._activeIndexObserver = null;
    }

    // Remove global reference if we published it
    try {
      // Use a typed view of window to avoid `any`.
      const win = (window as unknown as { hype?: Hype });
      if (typeof window !== "undefined" && win.hype === this) {
        try {
          delete win.hype;
        } catch {
          win.hype = undefined;
        }
      }
    } catch {
      /* ignore non-browser errors */
    }

    // Clear mounted root and allow a future mount() call
    this.rootElement = null;
    this.mounted = false;

    this.log("Hype unmounted");
  }

  /**
   * Destroy Hype instance, removing all listeners and running plugin cleanup.
   *
   * The method is idempotent: calling destroy() multiple times is safe.
   */
  destroy(): void {
    // Always attempt to remove any global reference to this instance prior to other teardown.
    // This ensures environments/tests that expect `window.hype` to be cleared won't see a stale reference.
    try {
      // Use a typed view of window to avoid `any`.
      const win = (window as unknown as { hype?: Hype });
      if (typeof window !== "undefined" && win.hype === this) {
        try {
          delete win.hype;
        } catch {
          // In some constrained hosts deletion may fail; unset as a fallback.
          win.hype = undefined;
        }
      }
    } catch {
      /* ignore non-browser errors */
    }

    // If not initialized and not mounted, nothing else to do (idempotent)
    if (!this.initialized && !this.mounted) {
      return;
    }

    // Ensure DOM wiring and mutation observers are removed
    try {
      this.unmount();
    } catch {
      /* ignore unmount errors */
    }

    // run any cleanup functions returned by attached plugins
    if (Array.isArray(this._attachedPluginCleanups) && this._attachedPluginCleanups.length) {
      for (const fn of this._attachedPluginCleanups) {
        try {
          fn();
        } catch {
          /* ignore plugin cleanup errors */
        }
      }
      this._attachedPluginCleanups = [];
    }

    // Clear interceptors and mark uninitialized
    try {
      this.interceptors.clear();
    } catch {
      /* ignore */
    }

    this.initialized = false;

    this.log("Hype destroyed");
  }

  /**
   * Add a request interceptor
   */
  onRequest(interceptor: RequestInterceptor): () => void {
    return this.interceptors.addRequestInterceptor(interceptor);
  }

  /**
   * Add a response interceptor
   */
  onResponse(interceptor: ResponseInterceptor): () => void {
    return this.interceptors.addResponseInterceptor(interceptor);
  }

  /**
   * Register a custom swap handler
   */
  registerSwap(name: string, handler: SwapHandler): () => void {
    return this.interceptors.registerSwapHandler(name, handler);
  }

  /**
   * Register a validation function
   */
  registerValidator(name: string, validator: ValidationFn): () => void {
    return this.interceptors.registerValidator(name, validator);
  }

  /**
   * Manually trigger a request on an element
   */
  async trigger(element: HTMLElement): Promise<void> {
    await this.processElement(element);
  }

  /**
   * Process an element and make the appropriate request
   */
  private async processElement(element: HTMLElement, submitter?: HTMLButtonElement | HTMLInputElement | null): Promise<void> {
    const methodInfo = this.getMethodAndUrl(element);
    if (!methodInfo) {
      return;
    }

    const { method, url } = methodInfo;

    // Get form data if this is a form
    let formData: FormData | undefined;
    if (element instanceof HTMLFormElement) {
      formData = serializeForm(element);
      if (submitter) {
        includeSubmitButton(formData, submitter);
      }

      // Merge additional values from hype-vals
      const valsAttr = element.getAttribute(this.attrs.vals);
      if (valsAttr) {
        mergeValues(formData, valsAttr);
      }

      // Run validation
      if (!(await this.validateElement(element, formData))) {
        return;
      }
    }

    // Build the request context
    const target = this.getTarget(element);
    const swap = this.getSwap(element);
    const abortController = this.setupAbortController(element as HypeElement);

    const ctx: RequestContext = {
      element,
      url,
      method,
      init: this.buildInit(method, formData, element, abortController),
      formData,
      target,
      swap,
      data: {},
      abortController,
    };

    // Run request
    await this.executeRequest(ctx);
  }

  /**
   * Handle form submissions
   */
  private handleSubmit(event: Event): void {
    const form = event.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    // Skip if the form is not marked with Hype attributes (no Hype behavior requested)
    if (!this.isHypeElement(form)) {
      return;
    }

    event.preventDefault();
    const submitter = getSubmitButton(form);
    this.processElement(form, submitter).catch((error) => {
      this.log("Error processing form", error);
    });
  }

  /**
   * Handle clicks on elements marked for Hype (links/buttons)
   */
  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    const element = this.findHypeElement(target);

    if (!element || element instanceof HTMLFormElement) {
      return;
    }

    // Skip form submit buttons - they're handled by form submission
    if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === "submit" && element.form) {
      return;
    }

    // Check for confirmation
    const confirmMsg = element.getAttribute(this.attrs.confirm);
    if (confirmMsg && !window.confirm(confirmMsg)) {
      return;
    }

    event.preventDefault();
    this.processElement(element).catch((error) => {
      this.log("Error processing element", error);
    });
  }

  /**
   * Handle DOM mutations
   */
  private handleMutations(mutations: MutationRecord[]): void {
    // Initialize reactive system on newly added elements
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          this.reactive.init(node);
        }
      });
    });
  }

  /**
   * Execute a fetch request
   */
  private async executeRequest(ctx: RequestContext): Promise<void> {
    // Dispatch before-request event
    const modifiedCtx = this.events.dispatchBeforeRequest(ctx);
    if (!modifiedCtx) {
      this.log("Request cancelled by event");
      return;
    }

    // Run request interceptors
    const interceptedCtx = await this.interceptors.runRequestInterceptors(modifiedCtx);

    // Show loading indicator
    this.setLoading(interceptedCtx.element, true);

    try {
      // Add timeout
      const timeoutId = setTimeout(() => {
        interceptedCtx.abortController.abort();
      }, this.config.timeout);

      // Make the fetch request using the injected fetcher if present.
      // Falls back to the global fetch when this.fetch isn't provided.
      const usedFetch = (this.fetch ?? ((input: RequestInfo, init?: RequestInit) => fetch(input, init)));
      const response = await usedFetch(interceptedCtx.url, interceptedCtx.init);

      clearTimeout(timeoutId);

      // Parse response
      const { body, isJson } = await this.parseResponse(response);

      // Build response context
      const responseCtx: ResponseContext = {
        ...interceptedCtx,
        response,
        body,
        isJson,
      };

      // Check for HTTP errors
      if (!response.ok && this.config.throwOnHttpError) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      // Run response interceptors
      const finalCtx = await this.interceptors.runResponseInterceptors(responseCtx);

      // Handle the response
      await this.handleResponse(finalCtx);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.log("Request aborted");
        return;
      }

      this.events.dispatchRequestError(interceptedCtx, error as Error);
      this.log("Request error", error);
    } finally {
      this.setLoading(interceptedCtx.element, false);
      this.cleanupAbortController(interceptedCtx.element as HypeElement);
    }
  }

  /**
   * Handle the response and perform swapping
   */
  private async handleResponse(ctx: ResponseContext): Promise<void> {
    // Handle JSON responses with directives
    if (ctx.isJson && typeof ctx.body === "object") {
      const json = ctx.body as HypeJsonResponse;

      // Handle redirect
      if (json.redirect) {
        window.location.href = json.redirect;
        return;
      }

      // Override target if specified
      if (json.target) {
        const newTarget = document.querySelector(json.target);
        if (newTarget instanceof HTMLElement) {
          ctx.target = newTarget;
        }
      }

      // Override swap if specified
      if (json.swap) {
        ctx.swap = json.swap;
      }

      // Get HTML to swap
      const html = json.html;
      if (html === undefined) {
        return;
      }

      // Prefer an explicit server-provided fingerprint (common keys: fp, fingerprint, etag)
      let incomingFingerprint: string | undefined = (json as any).fp ?? (json as any).fingerprint ?? (json as any).etag;

      // If server didn't provide a fingerprint, compute a local tagged fingerprint of the HTML.
      // Note: SHA-256 is stronger; FNV-1a is chosen here for speed and portability in the demo.
      if (!incomingFingerprint) {
        try {
          incomingFingerprint = await this.computeFingerprint(String(html));
        } catch {
          incomingFingerprint = undefined;
        }
      }

      await this.performSwap(ctx, html, json.settle, incomingFingerprint);
    } else if (typeof ctx.body === "string") {
      // Handle plain HTML response
      const html = ctx.body;
      let incomingFingerprint: string | undefined;
      try {
        // Compute local tagged fingerprint for the HTML (attempts 64-bit FNV1A, falls back to 32-bit).
        incomingFingerprint = await this.computeFingerprint(String(html));
      } catch {
        incomingFingerprint = undefined;
      }
      await this.performSwap(ctx, html, undefined, incomingFingerprint);
    }
  }

  /**
   * Perform the DOM swap
   */
  private async performSwap(ctx: ResponseContext, html: string, settleOverride?: number, incomingFingerprint?: string): Promise<void> {
    // Dispatch before-swap event
    const finalHtml = this.events.dispatchBeforeSwap(ctx, html);
    if (finalHtml === null) {
      this.log("Swap cancelled by event");
      return;
    }

    // Fingerprint attribute name (data- prefixed) derived from configured prefix base
    const base = typeof this.config.attributePrefix === 'string' ? (this.config.attributePrefix.startsWith('data-') ? this.config.attributePrefix.slice(5) : this.config.attributePrefix) : 'hype';
    const dataFpAttr = `data-${base}-fp`;

    // Read current fingerprint from the target (only data- variant)
    let currentFp: string | null = null;
    try {
      currentFp = ctx.target.getAttribute(dataFpAttr) ?? null;
    } catch {
      currentFp = null;
    }

    // If the incoming fingerprint is present and matches the current stored fingerprint,
    // skip the DOM swap entirely to avoid unnecessary reflows/updates.
    if (incomingFingerprint && currentFp && incomingFingerprint === currentFp) {
      // Parse the algorithm tag for logging/context if present
      const parsed = this.parseFingerprintTag(incomingFingerprint);
      const alg = parsed.alg ?? "unknown";
      this.log("Skipping swap: fingerprint matched", incomingFingerprint, "alg:", alg);
      // Respect settle delay semantics even when skipping
      const settleDelay = settleOverride ?? this.config.settleDelay;
      await new Promise((resolve) => setTimeout(resolve, settleDelay));
      // Fire after-swap and after-settle hooks to mimic completed swap lifecycle
      try {
        this.events.dispatchAfterSwap(ctx, ctx.target);
      } catch {}
      try {
        this.events.dispatchAfterSettle(ctx, ctx.target);
      } catch {}
      return;
    }

    // Custom swap handler takes precedence; otherwise always perform default swap.
    const customHandler = this.interceptors.getSwapHandler(ctx.swap);
    if (customHandler) {
      await customHandler(ctx.target, finalHtml, ctx.swap);
    } else {
      // Always use the default swap implementation (delegates to innerHTML/outerHTML/insertAdjacentHTML/etc).
      defaultSwap(ctx.target, finalHtml, ctx.swap);
    }

    // After a successful swap, if we have an incoming fingerprint, persist it on the target (data- variant).
    if (incomingFingerprint) {
      try {
        // Log algorithm tag when persisting so callers/diagnostics can see what was stored.
        const parsedPersist = this.parseFingerprintTag(incomingFingerprint);
        const persistAlg = parsedPersist.alg ?? "unknown";
        this.log("Persisting fingerprint", incomingFingerprint, "alg:", persistAlg);
        ctx.target.setAttribute(dataFpAttr, incomingFingerprint);
      } catch {
        /* ignore set failures */
      }
    }

    // Dispatch after-swap event
    this.events.dispatchAfterSwap(ctx, ctx.target);

    // Handle history
    if (this.config.history) {
      const pushAttr = ctx.element.getAttribute(this.attrs.push);
      if (pushAttr !== "false") {
        const url = pushAttr || ctx.url;
        if (this.config.history === "push") {
          window.history.pushState({}, "", url);
        } else if (this.config.history === "replace") {
          window.history.replaceState({}, "", url);
        }
      }
    }

    // Settle delay
    const settleDelay = settleOverride ?? this.config.settleDelay;
    await new Promise((resolve) => setTimeout(resolve, settleDelay));

    // Dispatch after-settle event
    this.events.dispatchAfterSettle(ctx, ctx.target);
  }

  /**
   * Parse the response body
   */
  private async parseResponse(response: Response): Promise<{
    body: string | HypeJsonResponse;
    isJson: boolean;
  }> {
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        const json = (await response.json()) as HypeJsonResponse;
        return { body: json, isJson: true };
      } catch {
        return { body: "", isJson: false };
      }
    }

    const text = await response.text();
    return { body: text, isJson: false };
  }

  /**
   * Validate an element (form)
   */
  private async validateElement(form: HTMLFormElement, formData: FormData): Promise<boolean> {
    // HTML5 validation first
    if (!validateFormHTML5(form)) {
      reportValidity(form);
      return false;
    }

    // Custom validation
    const validatorName = form.getAttribute(this.attrs.validate);
    if (validatorName) {
      const validator = this.interceptors.getValidator(validatorName);
      if (validator) {
        const result = await validator(form, formData);
        if (result !== true) {
          if (typeof result === "string") {
            this.log("Validation failed:", result);
          }
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Build fetch init options
   */
  private buildInit(method: HttpMethod, formData: FormData | undefined, element: HTMLElement, abortController: AbortController): RequestInit {
    const headers: Record<string, string> = { ...this.config.headers };

    // Add custom headers from element
    const headersAttr = element.getAttribute(this.attrs.headers);
    if (headersAttr) {
      try {
        Object.assign(headers, JSON.parse(headersAttr));
      } catch {
        this.log("Invalid headers JSON:", headersAttr);
      }
    }

    const init: RequestInit = {
      method,
      headers,
      credentials: this.config.credentials,
      signal: abortController.signal,
    };

    // Add body for methods that support it
    if (formData && method !== "GET") {
      const encoding = element.getAttribute(this.attrs.encoding) || undefined;
      const { body, contentType } = prepareRequestBody(method, formData, encoding);
      init.body = body;
      if (contentType) {
        headers["Content-Type"] = contentType;
      }
    }

    // For GET requests with form data, append to URL
    if (formData && method === "GET") {
      // URL modification is handled in getMethodAndUrl
    }

    return init;
  }

  /**
   * Get the HTTP method and URL from an element
   */
  private getMethodAndUrl(element: HTMLElement): { method: HttpMethod; url: string } | null {
    const methodAttrs = [
      { attr: this.attrs.get, method: "GET" as const },
      { attr: this.attrs.post, method: "POST" as const },
      { attr: this.attrs.put, method: "PUT" as const },
      { attr: this.attrs.delete, method: "DELETE" as const },
      { attr: this.attrs.patch, method: "PATCH" as const },
    ];

    for (const { attr, method } of methodAttrs) {
      const url = element.getAttribute(attr);
      if (url !== null) {
        // Handle GET requests with form data
        if (method === "GET" && element instanceof HTMLFormElement) {
          const formData = serializeForm(element);
          const params = formDataToParams(formData);
          const separator = url.includes("?") ? "&" : "?";
          return { method, url: `${url}${separator}${params.toString()}` };
        }
        return { method, url };
      }
    }

    // Check for boosted links/forms
    if (element.hasAttribute(this.attrs.boost)) {
      if (element instanceof HTMLFormElement) {
        const method = getFormMethod(element, this.config.attributePrefix);
        const url = getFormAction(element, this.config.attributePrefix);
        return { method, url };
      } else if (element instanceof HTMLAnchorElement && element.href) {
        return { method: "GET", url: element.href };
      }
    }

    return null;
  }

  /**
   * Get the target element for swapping
   */
  private getTarget(element: HTMLElement): HTMLElement {
    const targetSelector = element.getAttribute(this.attrs.target);

    if (targetSelector) {
      const target = document.querySelector(targetSelector);
      if (target instanceof HTMLElement) {
        return target;
      }
    }

    if (this.config.defaultTarget) {
      const target = document.querySelector(this.config.defaultTarget);
      if (target instanceof HTMLElement) {
        return target;
      }
    }

    return element;
  }

  /**
   * Get the swap strategy for an element
   */
  private getSwap(element: HTMLElement): SwapStrategy {
    const swapAttr = element.getAttribute(this.attrs.swap);
    if (swapAttr) {
      return swapAttr as SwapStrategy;
    }
    return this.config.defaultSwap;
  }

  /**
   * Set up abort controller for request deduplication
   */
  private setupAbortController(element: HypeElement): AbortController {
    const controller = new AbortController();

    // Handle deduplication
    if (this.config.dedupe === "cancel" && element._hypeActiveRequest) {
      element._hypeActiveRequest.abort();
    }

    if (this.config.dedupe !== "allow") {
      element._hypeActiveRequest = controller;
    }

    return controller;
  }

  /**
   * Clean up abort controller after request
   */
  private cleanupAbortController(element: HypeElement): void {
    delete element._hypeActiveRequest;
  }

  /**
   * Set loading state on an element
   */
  private setLoading(element: HTMLElement, loading: boolean): void {
    if (loading) {
      element.setAttribute("aria-busy", "true");
      element.classList.add("hype-loading");

      // Show loading indicator if specified
      const indicator = element.getAttribute(this.attrs.indicator);
      if (indicator) {
        const indicatorEl = document.querySelector(indicator);
        if (indicatorEl) {
          indicatorEl.classList.add("hype-show");
        }
      }

      // Disable element if specified
      const disabledElt = element.getAttribute(this.attrs.disabled);
      if (disabledElt) {
        document.querySelectorAll(disabledElt).forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
            el.disabled = true;
          }
        });
      }
    } else {
      element.removeAttribute("aria-busy");
      element.classList.remove("hype-loading");

      // Hide loading indicator
      const indicator = element.getAttribute(this.attrs.indicator);
      if (indicator) {
        const indicatorEl = document.querySelector(indicator);
        if (indicatorEl) {
          indicatorEl.classList.remove("hype-show");
        }
      }

      // Re-enable elements
      const disabledElt = element.getAttribute(this.attrs.disabled);
      if (disabledElt) {
        document.querySelectorAll(disabledElt).forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
            el.disabled = false;
          }
        });
      }
    }
  }

  /**
   * Check whether an element is marked with Hype attributes
   */
  private isHypeElement(element: HTMLElement): boolean {
    return (
      element.hasAttribute(this.attrs.get) ||
      element.hasAttribute(this.attrs.post) ||
      element.hasAttribute(this.attrs.put) ||
      element.hasAttribute(this.attrs.delete) ||
      element.hasAttribute(this.attrs.patch) ||
      element.hasAttribute(this.attrs.boost)
    );
  }

  /**
   * Find the nearest Hype element from a click target
   */
  private findHypeElement(target: HTMLElement): HTMLElement | null {
    let current: HTMLElement | null = target;

    while (current) {
      if (this.isHypeElement(current)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  /**
   * Debug logging
   */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log("[Hype]", ...args);
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): HypeConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  configure(config: Partial<HypeConfig>): void {
    this.config = { ...this.config, ...config };
    this.events.setDebug(this.config.debug);
    this.attrs = this.createAttributes(this.config.attributePrefix);
  }
}

/**
 * Create and return a new Hype instance
 *
 * Accepts an optional dependency bag so callers can inject implementations
 * for testing, customization, or alternative subsystems (IoC).
 *
 * The factory is explicit and accepts a `deps` bag for injecting dependencies:
 *   { events?: IEventSystem, host?: IRendererHost, fetch?: Fetcher, transport?: PubSubTransport }
 *
 * Behavior:
 * - `autoInit` defaults to `true` (runtime will mount to document.body if no root is provided
 *   and then start via `run()`).
 * - The factory wires typed `fetch` and `transport` onto the Hype instance and exposes
 *   `pub` and `onRemote` facades.
 */
export function createHype(
  config?: Partial<HypeConfig> & { root?: string | Element; host?: IRendererHost },
  deps: { events?: IEventSystem; host?: IRendererHost; fetch?: Fetcher; transport?: PubSubTransport } | boolean = {},
  autoInit: boolean = true
): Hype {
  // Backwards-compatibility: callers historically passed `false` as the second argument
  // to indicate `autoInit = false`. Support that legacy call-site shape by normalizing
  // a boolean `deps` into the `autoInit` flag and an empty deps object.
  if (typeof deps === "boolean") {
    autoInit = deps;
    deps = {};
  }

  const events = (deps as any)?.events;
  const resolvedRendererHost = (deps as any)?.host ?? (config as any)?.host;

  // Construct instance with optional renderer-host injection
  const instance = new Hype(config ?? {}, events, resolvedRendererHost);

  // Wire injected fetcher and transport in a typed, non-destructive way
  try {
    // Attach fetcher: prefer provided fetch, otherwise defaultFetcher
    instance.fetch = deps?.fetch ?? defaultFetcher;
    // Attach transport: prefer provided transport, otherwise NoopTransport
    instance.transport = deps?.transport ?? NoopTransport;

    // Provide small facades
    instance.pub = (topic: string, payload?: any) => {
      try {
        instance.transport?.publish(topic, payload);
      } catch {
        /* swallow publish errors */
      }
    };

    instance.onRemote = (topic: string, handler: (payload: any) => void) => {
      try {
        return instance.transport?.subscribe(topic, handler) ?? { unsubscribe() {} };
      } catch {
        return { unsubscribe() {} };
      }
    };

    // Forward raw transport messages into the instance's applySocketMessage if present
    try {
      if (typeof instance.transport?.onRawMessage === "function") {
        instance.transport.onRawMessage((m: any) => {
          try {
            instance.applySocketMessage?.(m);
          } catch {
            /* swallow handler errors */
          }
        });
      }
    } catch {
      /* ignore transport wiring errors */
    }

    // WS autowire deferred: autowire will be performed later, scoped to the mounted root (not the whole document).
    // The previous implementation scanned `document` eagerly. To respect sandboxing and scoping,
    // autowiring is now executed after mount (or against `document.body` only when autoInit is used).
    // The actual autowire logic is inserted further below (near the auto-init flow).
  } catch {
    // fail quietly - wiring is optional
  }

  // If the config provides a root, attempt to mount before starting the runtime.
  try {
    const maybeRoot = (config as any)?.root;
    if (maybeRoot) {
      try {
        instance.mount(maybeRoot as string | Element);
      } catch (mountErr) {
        if ((config as any)?.debug || (instance.getConfig && instance.getConfig().debug)) {
          // eslint-disable-next-line no-console
          console.warn("createHype: mount failed for provided config.root:", mountErr);
        }
        // Do not rethrow — mounting failure is non-fatal for creation.
      }
    }
  } catch {
    // Defensive no-op
  }

  // Auto-mount to document.body if requested and nothing is mounted yet.
  //
  // Deferred WebSocket autowire (scoped)
  //
  // We provide a small helper that discovers `-ws-url` attributes within a specific root
  // (the mounted root element). This avoids scanning the whole document and respects
  // `config.root` scoping. The helper accepts either an Element or Document as the scope.
  function autowireWsOnRoot(scopeRoot?: Element | Document | null) {
    try {
      if (!scopeRoot) return;
      // Prefer Element as container; if provided a Document, use its documentElement.
      const container: Element | null = scopeRoot instanceof Element ? scopeRoot : (scopeRoot as Document).documentElement ?? null;
      if (!container) return;

      const prefix = instance.getConfig().attributePrefix || 'hype';
      const base = prefix.startsWith('data-') ? prefix.slice(5) : prefix;
      const attrName = `data-${base}-ws-url`;
      // Only match the data- prefixed attribute for consistent markup-first usage
      const selector = `[${attrName}]`;
      const els = Array.from(container.querySelectorAll(selector));
      if (!els.length) return;

      const pool = new Map<string, PubSubTransport>();
      let rawHandlers: Array<(m: any) => void> = [];

      const getTransportFor = (url: string) => {
        let t = pool.get(url);
        if (t) return t;
        try {
          const created = createWebSocketTransport(url, { autoConnect: true });
          // forward raw messages to hype.applySocketMessage
          try {
            created.onRawMessage?.((m: any) => {
              try {
                instance.applySocketMessage?.(m);
              } catch {}
            });
          } catch {}
          // attach any existing raw handlers
          for (const h of rawHandlers) {
            try {
              created.onRawMessage?.(h);
            } catch {}
          }
          pool.set(url, created);
          return created;
        } catch {
          return NoopTransport;
        }
      };

      // Use the first discovered ws-url under this scope as the delegating default for convenience.
      const defaultAttr = els[0] && els[0].getAttribute(attrName);
      const defaultUrl = defaultAttr ? String(defaultAttr) : "";

      const delegating: PubSubTransport = {
        connect() {
          // no-op; pooled transports auto-connect
        },
        disconnect() {
          for (const t of Array.from(pool.values())) {
            try {
              t.disconnect?.();
            } catch {}
          }
          pool.clear();
        },
        publish(topic: string, payload?: any) {
          try {
            if (!defaultUrl) return;
            const t = getTransportFor(defaultUrl);
            if (t && typeof (t as any).publish === "function") {
              try { (t as any).publish(topic, payload); } catch {}
            }
          } catch {}
        },
        subscribe(topic: string, handler: (payload: any, msg?: any) => void) {
          try {
            if (!defaultUrl) return { unsubscribe() {} };
            const t = getTransportFor(defaultUrl);
            if (t && typeof (t as any).subscribe === "function") {
              try { return (t as any).subscribe(topic, handler); } catch { return { unsubscribe() {} }; }
            }
            return { unsubscribe() {} };
          } catch { return { unsubscribe() {} }; }
        },
        onRawMessage(handler: (m: any) => void) {
          rawHandlers.push(handler);
          for (const t of Array.from(pool.values())) {
            try { t.onRawMessage?.(handler); } catch {}
          }
        },
      };

      // If the instance currently uses NoopTransport (no explicit injection), install delegator.
      if ((((deps as any)?.transport) ?? NoopTransport) === NoopTransport) {
        try { instance.transport = delegating; } catch {}
      }

      // Expose pool for consumers/plugins to inspect if desired (non-typed)
      try { (instance as any).transportPool = pool; } catch {}
      // Rebind facades to ensure they use the (possibly) new transport
      instance.pub = (topic: string, payload?: any) => {
        try { instance.transport?.publish(topic, payload); } catch {}
      };
      instance.onRemote = (topic: string, handler: (payload: any) => void) => {
        try { return instance.transport?.subscribe(topic, handler) ?? { unsubscribe() {} }; } catch { return { unsubscribe() {} }; }
      };
    } catch {
      /* swallow autowire errors */
    }
  }

  // Run autowire now if we already have a mounted root (config.root mount succeeded).
  try {
    autowireWsOnRoot(instance['rootElement'] ?? null);
  } catch {}

  // If autoInit is true and no explicit root was mounted, prefer to autowire the soon-to-be-mounted body.
  // This keeps backwards-compatible behavior for the default autoInit flow while still scoping to body,
  // not the entire document.
  try {
    if (!instance['rootElement'] && autoInit && typeof document !== 'undefined') {
      autowireWsOnRoot(document);
    }
  } catch {}
  if (autoInit) {
    try {
      try {
        // Mount to body if no explicit root provided; ignore failures.
        if (typeof document !== "undefined") {
          try {
            instance.mount(document.body);
          } catch {
            // mount may already have been called or not applicable; ignore
          }
        }
      } catch {
        /* ignore mount errors */
      }

      // Start runtime via canonical entrypoint
      instance.run();
    } catch {
      // Swallow errors to keep factory safe for programmatic construction.
    }
  }

  return instance;
}

/**
 * Default Hype instance for convenience
 *
 * Create a prewired default instance and auto-start it. Consumers who wish to
 * manage lifecycle explicitly should call `createHype(...)` themselves.
 */
export const hype: Hype = createHype(undefined, {}, true);



// Re-export common built-in plugins from the `plugins` directory so consumers can
// import them directly from the main package (e.g. `import { pubsubPlugin } from './hype'`).
export { pubsubPlugin } from "./plugins/pubsub";
export { behaviorPlugin } from "./plugins/behavior";
// The auth plugin is provided alongside other plugins in `src/plugins/auth.ts`.
// Consumers can opt-in by calling `hype.attach(authPlugin)`.
export { authPlugin } from "./plugins/auth";
