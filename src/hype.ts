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
} from './types';
import { EventSystem } from './events';
import { InterceptorRegistry, defaultSwap } from './interceptors';
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
} from './form';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: HypeConfig = {
  defaultSwap: 'innerHTML',
  settleDelay: 20,
  timeout: 30000,
  credentials: 'same-origin',
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
  },
  throwOnHttpError: false,
  dedupe: 'cancel',
  history: false,
  attributePrefix: 'hype',
  debug: false,
};

/**
 * Hype - A minimal progressive-enhancement fetch enhancer
 * 
 * @example
 * ```html
 * <!-- Progressive enhancement: works without JS, enhanced with JS -->
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
  private attrs: HypeAttributes;
  private observer: MutationObserver | null = null;
  private initialized = false;

  constructor(config: Partial<HypeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = new EventSystem(this.config.debug);
    this.interceptors = new InterceptorRegistry();
    this.attrs = this.createAttributes(this.config.attributePrefix);
  }

  /**
   * Create attribute names based on prefix
   */
  private createAttributes(prefix: string): HypeAttributes {
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
   * Initialize Hype on the document
   * Sets up event listeners and observes DOM changes
   */
  init(): void {
    if (this.initialized) {
      return;
    }

    this.log('Initializing Hype');

    // Set up event delegation
    document.addEventListener('submit', this.handleSubmit.bind(this), true);
    document.addEventListener('click', this.handleClick.bind(this), true);

    // Set up mutation observer for dynamically added elements
    this.observer = new MutationObserver(this.handleMutations.bind(this));
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.initialized = true;
  }

  /**
   * Destroy Hype instance, removing all listeners
   */
  destroy(): void {
    if (!this.initialized) {
      return;
    }

    document.removeEventListener('submit', this.handleSubmit.bind(this), true);
    document.removeEventListener('click', this.handleClick.bind(this), true);

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    this.interceptors.clear();
    this.initialized = false;

    this.log('Hype destroyed');
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
  private async processElement(
    element: HTMLElement,
    submitter?: HTMLButtonElement | HTMLInputElement | null
  ): Promise<void> {
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
      if (!await this.validateElement(element, formData)) {
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

    // Check if this form is Hype-enhanced
    if (!this.isHypeElement(form)) {
      return;
    }

    event.preventDefault();
    const submitter = getSubmitButton(form);
    this.processElement(form, submitter).catch((error) => {
      this.log('Error processing form', error);
    });
  }

  /**
   * Handle clicks on enhanced links/buttons
   */
  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    const element = this.findHypeElement(target);

    if (!element || element instanceof HTMLFormElement) {
      return;
    }

    // Skip form submit buttons - they're handled by form submission
    if (
      (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
      element.type === 'submit' &&
      element.form
    ) {
      return;
    }

    // Check for confirmation
    const confirmMsg = element.getAttribute(this.attrs.confirm);
    if (confirmMsg && !window.confirm(confirmMsg)) {
      return;
    }

    event.preventDefault();
    this.processElement(element).catch((error) => {
      this.log('Error processing element', error);
    });
  }

  /**
   * Handle DOM mutations
   */
  private handleMutations(_mutations: MutationRecord[]): void {
    // Currently just for future use (auto-init new elements, etc.)
  }

  /**
   * Execute a fetch request
   */
  private async executeRequest(ctx: RequestContext): Promise<void> {
    // Dispatch before-request event
    const modifiedCtx = this.events.dispatchBeforeRequest(ctx);
    if (!modifiedCtx) {
      this.log('Request cancelled by event');
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
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.log('Request aborted');
        return;
      }

      this.events.dispatchRequestError(interceptedCtx, error as Error);
      this.log('Request error', error);
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
    if (ctx.isJson && typeof ctx.body === 'object') {
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
    } else if (typeof ctx.body === 'string') {
      // Handle plain HTML response
      await this.performSwap(ctx, ctx.body);
    }
  }

  /**
   * Perform the DOM swap
   */
  private async performSwap(
    ctx: ResponseContext,
    html: string,
    settleOverride?: number
  ): Promise<void> {
    // Dispatch before-swap event
    const finalHtml = this.events.dispatchBeforeSwap(ctx, html);
    if (finalHtml === null) {
      this.log('Swap cancelled by event');
      return;
    }

    // Check for custom swap handler
    const customHandler = this.interceptors.getSwapHandler(ctx.swap);
    if (customHandler) {
      await customHandler(ctx.target, finalHtml, ctx.swap);
    } else {
      defaultSwap(ctx.target, finalHtml, ctx.swap);
    }

    // Dispatch after-swap event
    this.events.dispatchAfterSwap(ctx, ctx.target);

    // Handle history
    if (this.config.history) {
      const pushAttr = ctx.element.getAttribute(this.attrs.push);
      if (pushAttr !== 'false') {
        const url = pushAttr || ctx.url;
        if (this.config.history === 'push') {
          window.history.pushState({}, '', url);
        } else if (this.config.history === 'replace') {
          window.history.replaceState({}, '', url);
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
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        const json = await response.json() as HypeJsonResponse;
        return { body: json, isJson: true };
      } catch {
        return { body: '', isJson: false };
      }
    }

    const text = await response.text();
    return { body: text, isJson: false };
  }

  /**
   * Validate an element (form)
   */
  private async validateElement(
    form: HTMLFormElement,
    formData: FormData
  ): Promise<boolean> {
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
          if (typeof result === 'string') {
            this.log('Validation failed:', result);
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
  private buildInit(
    method: HttpMethod,
    formData: FormData | undefined,
    element: HTMLElement,
    abortController: AbortController
  ): RequestInit {
    const headers: Record<string, string> = { ...this.config.headers };

    // Add custom headers from element
    const headersAttr = element.getAttribute(this.attrs.headers);
    if (headersAttr) {
      try {
        Object.assign(headers, JSON.parse(headersAttr));
      } catch {
        this.log('Invalid headers JSON:', headersAttr);
      }
    }

    const init: RequestInit = {
      method,
      headers,
      credentials: this.config.credentials,
      signal: abortController.signal,
    };

    // Add body for methods that support it
    if (formData && method !== 'GET') {
      const encoding = element.getAttribute(this.attrs.encoding) || undefined;
      const { body, contentType } = prepareRequestBody(method, formData, encoding);
      init.body = body;
      if (contentType) {
        headers['Content-Type'] = contentType;
      }
    }

    // For GET requests with form data, append to URL
    if (formData && method === 'GET') {
      // URL modification is handled in getMethodAndUrl
    }

    return init;
  }

  /**
   * Get the HTTP method and URL from an element
   */
  private getMethodAndUrl(
    element: HTMLElement
  ): { method: HttpMethod; url: string } | null {
    const methodAttrs = [
      { attr: this.attrs.get, method: 'GET' as const },
      { attr: this.attrs.post, method: 'POST' as const },
      { attr: this.attrs.put, method: 'PUT' as const },
      { attr: this.attrs.delete, method: 'DELETE' as const },
      { attr: this.attrs.patch, method: 'PATCH' as const },
    ];

    for (const { attr, method } of methodAttrs) {
      const url = element.getAttribute(attr);
      if (url !== null) {
        // Handle GET requests with form data
        if (method === 'GET' && element instanceof HTMLFormElement) {
          const formData = serializeForm(element);
          const params = formDataToParams(formData);
          const separator = url.includes('?') ? '&' : '?';
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
        return { method: 'GET', url: element.href };
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
    if (this.config.dedupe === 'cancel' && element._hypeActiveRequest) {
      element._hypeActiveRequest.abort();
    }

    if (this.config.dedupe !== 'allow') {
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
      element.setAttribute('aria-busy', 'true');
      element.classList.add('hype-loading');

      // Show loading indicator if specified
      const indicator = element.getAttribute(this.attrs.indicator);
      if (indicator) {
        const indicatorEl = document.querySelector(indicator);
        if (indicatorEl) {
          indicatorEl.classList.add('hype-show');
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
      element.removeAttribute('aria-busy');
      element.classList.remove('hype-loading');

      // Hide loading indicator
      const indicator = element.getAttribute(this.attrs.indicator);
      if (indicator) {
        const indicatorEl = document.querySelector(indicator);
        if (indicatorEl) {
          indicatorEl.classList.remove('hype-show');
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
   * Check if an element is Hype-enhanced
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
      console.log('[Hype]', ...args);
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
