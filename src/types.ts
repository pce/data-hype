/**
 * HTTP methods supported by Hype
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * Swap strategies for inserting HTML into the DOM
 */
export type SwapStrategy = "innerHTML" | "innerText" | "outerHTML" | "beforebegin" | "afterbegin" | "beforeend" | "afterend" | "delete" | "none";

/**
 * Hype event names
 */
export type HypeEventName = "hype:before-request" | "hype:before-swap" | "hype:after-swap" | "hype:after-settle" | "hype:request-error" | "hype:response-error";

/**
 * Configuration options for Hype
 */
export interface PluginConfig {
  /** Attach built-in pub/sub plugin (default: true) */
  pubsub?: boolean;
  /** Attach built-in behavior registry & debounce plugin (default: true) */
  behavior?: boolean;
  /** Whether default debounce wiring should be enabled (default: true) */
  debounce?: boolean;
}

/**
 * Configuration options for Hype
 */
export interface HypeConfig {
  /** Default swap strategy */
  defaultSwap: SwapStrategy;
  /** Default target selector (uses element itself if not set) */
  defaultTarget?: string;
  /** Settle delay in milliseconds after swap */
  settleDelay: number;
  /** Timeout for fetch requests in milliseconds */
  timeout: number;
  /** Whether to include credentials in fetch requests */
  credentials: RequestCredentials;
  /** Default headers to include in all requests */
  headers: Record<string, string>;
  /** Whether to throw on non-2xx responses */
  throwOnHttpError: boolean;
  /** Request deduplication behavior: 'cancel' previous, 'ignore' new, or 'allow' all */
  dedupe: "cancel" | "ignore" | "allow";
  /** History push behavior: 'push', 'replace', or false */
  history: "push" | "replace" | false;
  /** Attribute prefix (default: 'hype') */
  attributePrefix: string;
  /** Enable debug logging */
  debug: boolean;
  /** Optional plugin toggles (pubsub / behavior / debounce) */
  plugins?: PluginConfig;
}

/**
 * Request context passed to interceptors and events
 */
export interface RequestContext {
  /** The element that triggered the request */
  element: HTMLElement;
  /** The URL being requested */
  url: string;
  /** The HTTP method */
  method: HttpMethod;
  /** The fetch init options */
  init: RequestInit;
  /** Form data if this is a form submission */
  formData?: FormData;
  /** The target element for swapping */
  target: HTMLElement;
  /** The swap strategy to use */
  swap: SwapStrategy;
  /** Custom data bag for interceptors */
  data: Record<string, unknown>;
  /** Abort controller for this request */
  abortController: AbortController;
}

/**
 * Response context after fetch completes
 */
export interface ResponseContext extends RequestContext {
  /** The fetch response */
  response: Response;
  /** The response body as text or JSON */
  body: string | HypeJsonResponse;
  /** Whether the response was JSON */
  isJson: boolean;
}

/**
 * JSON response format that Hype understands
 */
export interface HypeJsonResponse {
  /** HTML content to swap */
  html?: string;
  /** URL to redirect to */
  redirect?: string;
  /** Target selector override */
  target?: string;
  /** Swap strategy override */
  swap?: SwapStrategy;
  /** Settle delay override */
  settle?: number;
  /** Additional data */
  [key: string]: unknown;
}

/**
 * Request interceptor function
 */
export type RequestInterceptor = (ctx: RequestContext) => RequestContext | Promise<RequestContext> | void | Promise<void>;

/**
 * Response interceptor function
 */
export type ResponseInterceptor = (ctx: ResponseContext) => ResponseContext | Promise<ResponseContext> | void | Promise<void>;

/**
 * Custom swap handler function
 */
export type SwapHandler = (target: HTMLElement, html: string, strategy: SwapStrategy) => void | Promise<void>;

/**
 * Validation function for forms
 */
export type ValidationFn = (form: HTMLFormElement, formData: FormData) => boolean | string | Promise<boolean | string>;

/**
 * Event detail for hype:before-request
 */
export interface BeforeRequestDetail {
  context: RequestContext;
  cancel: () => void;
}

/**
 * Event detail for hype:before-swap
 */
export interface BeforeSwapDetail {
  context: ResponseContext;
  html: string;
  cancel: () => void;
}

/**
 * Event detail for hype:after-swap
 */
export interface AfterSwapDetail {
  context: ResponseContext;
  target: HTMLElement;
}

/**
 * Event detail for hype:after-settle
 */
export interface AfterSettleDetail {
  context: ResponseContext;
  target: HTMLElement;
}

/**
 * Event detail for hype:request-error
 */
export interface RequestErrorDetail {
  context: RequestContext;
  error: Error;
}

/**
 * Event detail for hype:response-error
 */
export interface ResponseErrorDetail {
  context: ResponseContext;
  error: Error;
}

/**
 * Combined event detail type
 */
export type HypeEventDetail = BeforeRequestDetail | BeforeSwapDetail | AfterSwapDetail | AfterSettleDetail | RequestErrorDetail | ResponseErrorDetail;

/**
 * Hype custom event
 */
export interface HypeEvent<T extends HypeEventDetail = HypeEventDetail> extends CustomEvent<T> {
  type: HypeEventName;
}

/**
 * Element with active request tracking
 */
export interface HypeElement extends HTMLElement {
  _hypeActiveRequest?: AbortController;
}

/**
 * Attribute names used by Hype
 */
export interface HypeAttributes {
  get: string;
  post: string;
  put: string;
  delete: string;
  patch: string;
  target: string;
  swap: string;
  trigger: string;
  confirm: string;
  validate: string;
  indicator: string;
  disabled: string;
  headers: string;
  vals: string;
  encoding: string;
  push: string;
  boost: string;
}
