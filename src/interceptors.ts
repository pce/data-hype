import type {
  RequestContext,
  ResponseContext,
  RequestInterceptor,
  ResponseInterceptor,
  SwapHandler,
  SwapStrategy,
  ValidationFn,
} from './types';

/**
 * Interceptor registry for managing request/response interceptors
 */
export class InterceptorRegistry {
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private swapHandlers: Map<string, SwapHandler> = new Map();
  private validators: Map<string, ValidationFn> = new Map();

  /**
   * Add a request interceptor
   * Interceptors are called in order of addition
   */
  addRequestInterceptor(interceptor: RequestInterceptor): () => void {
    this.requestInterceptors.push(interceptor);
    return () => {
      const index = this.requestInterceptors.indexOf(interceptor);
      if (index > -1) {
        this.requestInterceptors.splice(index, 1);
      }
    };
  }

  /**
   * Add a response interceptor
   * Interceptors are called in order of addition
   */
  addResponseInterceptor(interceptor: ResponseInterceptor): () => void {
    this.responseInterceptors.push(interceptor);
    return () => {
      const index = this.responseInterceptors.indexOf(interceptor);
      if (index > -1) {
        this.responseInterceptors.splice(index, 1);
      }
    };
  }

  /**
   * Register a custom swap handler for a named strategy
   */
  registerSwapHandler(name: string, handler: SwapHandler): () => void {
    this.swapHandlers.set(name, handler);
    return () => {
      this.swapHandlers.delete(name);
    };
  }

  /**
   * Get a registered swap handler
   */
  getSwapHandler(name: string): SwapHandler | undefined {
    return this.swapHandlers.get(name);
  }

  /**
   * Register a named validation function
   */
  registerValidator(name: string, validator: ValidationFn): () => void {
    this.validators.set(name, validator);
    return () => {
      this.validators.delete(name);
    };
  }

  /**
   * Get a registered validator
   */
  getValidator(name: string): ValidationFn | undefined {
    return this.validators.get(name);
  }

  /**
   * Run all request interceptors on a context
   * Returns the potentially modified context
   */
  async runRequestInterceptors(ctx: RequestContext): Promise<RequestContext> {
    let result = ctx;
    for (const interceptor of this.requestInterceptors) {
      const modified = await interceptor(result);
      if (modified) {
        result = modified;
      }
    }
    return result;
  }

  /**
   * Run all response interceptors on a context
   * Returns the potentially modified context
   */
  async runResponseInterceptors(ctx: ResponseContext): Promise<ResponseContext> {
    let result = ctx;
    for (const interceptor of this.responseInterceptors) {
      const modified = await interceptor(result);
      if (modified) {
        result = modified;
      }
    }
    return result;
  }

  /**
   * Clear all interceptors and handlers
   */
  clear(): void {
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    this.swapHandlers.clear();
    this.validators.clear();
  }
}

/**
 * Default swap implementation
 */
export function defaultSwap(
  target: HTMLElement,
  html: string,
  strategy: SwapStrategy
): void {
  switch (strategy) {
    case 'innerHTML':
      target.innerHTML = html;
      break;

    case 'outerHTML':
      target.outerHTML = html;
      break;

    case 'beforebegin':
      target.insertAdjacentHTML('beforebegin', html);
      break;

    case 'afterbegin':
      target.insertAdjacentHTML('afterbegin', html);
      break;

    case 'beforeend':
      target.insertAdjacentHTML('beforeend', html);
      break;

    case 'afterend':
      target.insertAdjacentHTML('afterend', html);
      break;

    case 'delete':
      target.remove();
      break;

    case 'none':
      // Do nothing
      break;

    default:
      // For custom strategies, fall back to innerHTML
      target.innerHTML = html;
  }
}
