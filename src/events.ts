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
} from "./types";

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
  dispatch<T extends HypeEventDetail>(element: HTMLElement, eventName: HypeEventName, detail: T): boolean {
    if (this.debug) {
      // Produce a compact, deterministic summary to avoid logging full DOM trees.
      // Many event detail objects include a `context.element` which, when logged
      // directly, can expand into enormous DOM prints in tests or consoles.
      // Here we replace that element reference with a small summary (tag, id, classes, dataset).
      const dAny = detail as any;
      const candidateEl = (dAny && dAny.context && dAny.context.element) || element;
      let elSummary: any = undefined;
      if (candidateEl && candidateEl.tagName) {
        elSummary = {
          tagName: candidateEl.tagName,
          id: candidateEl.id || undefined,
          className: candidateEl.className || undefined,
          dataset: candidateEl.dataset ? { ...candidateEl.dataset } : undefined,
        };
      } else {
        elSummary = candidateEl;
      }
      const safeDetail = Object.assign({}, dAny, {
        context: dAny && dAny.context ? Object.assign({}, dAny.context, { element: elSummary }) : dAny.context,
      });
      console.log(`[Hype] Dispatching ${eventName}`, safeDetail);
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

    const notPrevented = this.dispatch(ctx.element, "hype:before-request", detail);

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

    const notPrevented = this.dispatch(ctx.element, "hype:before-swap", detail);

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

    this.dispatch(ctx.element, "hype:after-swap", detail);
  }

  /**
   * Dispatch after-settle event
   */
  dispatchAfterSettle(ctx: ResponseContext, target: HTMLElement): void {
    const detail: AfterSettleDetail = {
      context: ctx,
      target,
    };

    this.dispatch(ctx.element, "hype:after-settle", detail);
  }

  /**
   * Dispatch request-error event
   */
  dispatchRequestError(ctx: RequestContext, error: Error): void {
    const detail: RequestErrorDetail = {
      context: ctx,
      error,
    };

    this.dispatch(ctx.element, "hype:request-error", detail);
  }

  /**
   * Dispatch response-error event
   */
  dispatchResponseError(ctx: ResponseContext, error: Error): void {
    const detail: ResponseErrorDetail = {
      context: ctx,
      error,
    };

    this.dispatch(ctx.element, "hype:response-error", detail);
  }
}

/**
 * Default event system instance
 */
export const eventSystem = new EventSystem();
