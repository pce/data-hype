import type {
  HypeEventName,
  HypeEventDetail,
  BeforeRequestDetail,
  BeforeSwapDetail,
  AfterSwapDetail,
  AfterSettleDetail,
  RequestErrorDetail,
  ResponseErrorDetail,
  RequestContext,
  ResponseContext,
} from './types';

/**
 * Event system for Hype
 * Provides a centralized way to dispatch and listen for Hype events
 */
export class EventSystem {
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  /**
   * Enable or disable debug logging
   */
  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  /**
   * Dispatch a custom event on an element
   * Returns true if the event was not cancelled
   */
  dispatch<T extends HypeEventDetail>(
    element: HTMLElement,
    eventName: HypeEventName,
    detail: T
  ): boolean {
    if (this.debug) {
      console.log(`[Hype] Dispatching ${eventName}`, detail);
    }

    const event = new CustomEvent(eventName, {
      bubbles: true,
      cancelable: true,
      detail,
    });

    return element.dispatchEvent(event);
  }

  /**
   * Dispatch before-request event
   * Returns the context if not cancelled, null otherwise
   */
  dispatchBeforeRequest(ctx: RequestContext): RequestContext | null {
    let cancelled = false;
    const detail: BeforeRequestDetail = {
      context: ctx,
      cancel: () => {
        cancelled = true;
      },
    };

    const notPrevented = this.dispatch(ctx.element, 'hype:before-request', detail);

    if (!notPrevented || cancelled) {
      return null;
    }

    return detail.context;
  }

  /**
   * Dispatch before-swap event
   * Returns the HTML to swap if not cancelled, null otherwise
   */
  dispatchBeforeSwap(ctx: ResponseContext, html: string): string | null {
    let cancelled = false;
    const detail: BeforeSwapDetail = {
      context: ctx,
      html,
      cancel: () => {
        cancelled = true;
      },
    };

    const notPrevented = this.dispatch(ctx.element, 'hype:before-swap', detail);

    if (!notPrevented || cancelled) {
      return null;
    }

    return detail.html;
  }

  /**
   * Dispatch after-swap event
   */
  dispatchAfterSwap(ctx: ResponseContext, target: HTMLElement): void {
    const detail: AfterSwapDetail = {
      context: ctx,
      target,
    };

    this.dispatch(ctx.element, 'hype:after-swap', detail);
  }

  /**
   * Dispatch after-settle event
   */
  dispatchAfterSettle(ctx: ResponseContext, target: HTMLElement): void {
    const detail: AfterSettleDetail = {
      context: ctx,
      target,
    };

    this.dispatch(ctx.element, 'hype:after-settle', detail);
  }

  /**
   * Dispatch request-error event
   */
  dispatchRequestError(ctx: RequestContext, error: Error): void {
    const detail: RequestErrorDetail = {
      context: ctx,
      error,
    };

    this.dispatch(ctx.element, 'hype:request-error', detail);
  }

  /**
   * Dispatch response-error event
   */
  dispatchResponseError(ctx: ResponseContext, error: Error): void {
    const detail: ResponseErrorDetail = {
      context: ctx,
      error,
    };

    this.dispatch(ctx.element, 'hype:response-error', detail);
  }
}

/**
 * Default event system instance
 */
export const eventSystem = new EventSystem();
