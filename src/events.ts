import type {
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
import type { IEventSystem, ObservableLike, HypeEvent } from "./interfaces/event-system.interface";

/**
 * Event system for Hype
 * Provides a centralized way to dispatch and listen for Hype events
 */
export class EventSystem implements IEventSystem<HypeEventDetail> {
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
  // Accept arbitrary string event names to allow adapters/tests to emit
  // non-core Hype event names (e.g. custom namespaces). Implementations may
  // choose to enforce Hype-specific names but the interface remains permissive.
  dispatch(element: HTMLElement, eventName: string, detail?: HypeEventDetail): boolean {
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
      detail: detail as any,
    });

    const dispatched = element.dispatchEvent(event);

    return dispatched;
  }

  /**
   * Return an Observable-like subscribable for a given event name.
   * For DOM-hosted runtimes we create a lightweight subscribable that attaches
   * a global listener (bubbles) and translates DOM CustomEvents into the
   * HypeEvent<{...}> shape expected by consumers.
   */
  asObservable(eventName: string): ObservableLike<HypeEvent<HypeEventDetail>> {
    return {
      subscribe: (handler: (payload: HypeEvent<HypeEventDetail>) => void) => {
        const listener = (ev: Event) => {
          try {
            const ce = ev as CustomEvent;
            const el = (ce && (ce.target as HTMLElement)) || (ev as any).target || null;
            handler({ element: el as HTMLElement, detail: (ce as any)?.detail });
          } catch {
            /* swallow handler errors */
          }
        };
        // Use capture false so we follow normal bubbling semantics; listeners can
        // inspect event.detail.context.element to find originating node.
        window.addEventListener(eventName, listener as EventListener);
        return {
          unsubscribe: () => {
            try {
              window.removeEventListener(eventName, listener as EventListener);
            } catch {
              /* ignore */
            }
          },
        };
      },
      // pipe is optional on ObservableLike; DOM subscribable does not implement it.
    };
  }

  /**
   * Convenience alias that returns the same shape as asObservable for callers
   * that prefer an `on(name).subscribe()` surface.
   */
  on(eventName: string): ObservableLike<HypeEvent<HypeEventDetail>> {
    return this.asObservable(eventName);
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
 * Default event system factory + default instance
 */
export function createEventSystem(debug = false): IEventSystem<HypeEventDetail> {
  return new EventSystem(debug);
}

/**
 * Default event system instance
 */
export const eventSystem = createEventSystem();

/**
 * Default export for convenience
 */
export default eventSystem;
