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
import { EventSystem } from "./events";
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
export class Hype {
  private config: HypeConfig;
  private events: EventSystem;
  private interceptors: InterceptorRegistry;
  private reactive: ReactiveSystem;
  private attrs: HypeAttributes;
  private observer: MutationObserver | null = null;

  // Plugin cleanup is handled centrally via `_attachedPluginCleanups`.
  // Per-feature leftover cleanup fields removed.

  // cleanup functions returned by attached plugins (if plugin returns a teardown)
  private _attachedPluginCleanups: Array<() => void> = [];

  // MutationObserver used to watch for `data-hype-active-index` changes (snap behavior).
  // Hype will update optional UI targets when behaviors set this attribute.
  private _activeIndexObserver: MutationObserver | null = null;

  private initialized = false;

  constructor(config: Partial<HypeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = new EventSystem(this.config.debug);
    this.interceptors = new InterceptorRegistry();
    this.reactive = new ReactiveSystem(this.config);
    this.attrs = this.createAttributes(this.config.attributePrefix);
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
  init(plugins?: unknown | unknown[]): void {
    if (this.initialized) {
      return;
    }

    this.log("Initializing Hype");

    // If plugins were provided on init, attach them first so they can hook before wiring
    if (plugins) {
      const list = Array.isArray(plugins) ? plugins : [plugins];
      for (const p of list) {
        this.attach(p);
      }
    }

    // Set up event delegation
    document.addEventListener("submit", this.handleSubmit.bind(this), true);
    document.addEventListener("click", this.handleClick.bind(this), true);

    // Initialize reactive system on document body
    this.reactive.init(document.body);

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

    // Set up mutation observer for dynamically added elements
    this.observer = new MutationObserver(this.handleMutations.bind(this));
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Expose the instance on window for behavior implementations that rely on a global helper.
    // This keeps backward compatibility with examples that reference `window.hype.templateClone`.
    try {
      if (typeof window !== "undefined") {
        (window as any).hype = this;
      }
    } catch {
      /* ignore non-browser environments */
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

    this.initialized = true;
  }

  /**
   * Destroy Hype instance, removing all listeners
   */
  destroy(): void {
    if (!this.initialized) {
      return;
    }

    document.removeEventListener("submit", this.handleSubmit.bind(this), true);
    document.removeEventListener("click", this.handleClick.bind(this), true);

    if (this.observer) {
      this.observer.disconnect();
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
      if (typeof window !== "undefined" && (window as any).hype === this) {
        try {
          delete (window as any).hype;
        } catch {
          (window as any).hype = undefined;
        }
      }
    } catch {
      /* ignore non-browser errors */
    }

    // plugin-specific cleanup is handled via `_attachedPluginCleanups` (invoked below).
    // Individual `_behaviorCleanup` / `_debounceCleanup` fields were removed in favor of the
    // unified plugin lifecycle management.

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

    this.interceptors.clear();
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

      // Make the fetch request
      const response = await fetch(interceptedCtx.url, interceptedCtx.init);

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

      await this.performSwap(ctx, html, json.settle);
    } else if (typeof ctx.body === "string") {
      // Handle plain HTML response
      await this.performSwap(ctx, ctx.body);
    }
  }

  /**
   * Perform the DOM swap
   */
  private async performSwap(ctx: ResponseContext, html: string, settleOverride?: number): Promise<void> {
    // Dispatch before-swap event
    const finalHtml = this.events.dispatchBeforeSwap(ctx, html);
    if (finalHtml === null) {
      this.log("Swap cancelled by event");
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
 */
export function createHype(config?: Partial<HypeConfig>): Hype {
  return new Hype(config);
}

/**
 * Default Hype instance for convenience
 */
export const hype = createHype();

// Re-export common built-in plugins from the `plugins` directory so consumers can
// import them directly from the main package (e.g. `import { pubsubPlugin } from './hype'`).
export { pubsubPlugin } from "./plugins/pubsub";
export { behaviorPlugin } from "./plugins/behavior";
// The auth plugin is provided alongside other plugins in `src/plugins/auth.ts`.
// Consumers can opt-in by calling `hype.attach(authPlugin)`.
export { authPlugin } from "./plugins/auth";
