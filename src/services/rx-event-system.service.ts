/**
 * RxJS-backed Event System adapter for Hype (optional)
 *
 * This adapter implements the IEventSystem contract and will use RxJS if it's
 * available at runtime. If RxJS isn't present, it falls back to a tiny
 * internal Subject/Observable shim so this file no longer requires rxjs at
 * compile time.
 *
 * The shim provides the minimal behavior we need: subscribe/unsubscribe, next(),
 * and complete(). The runtime selection is lazy and transparent to callers.
 *
 * This keeps the module optional (no hard dependency) while still providing a
 * pleasant Observable API for consumers that want it.
 */
import type { IEventSystem, HypeEvent, ObservableLike } from "../interfaces/event-system.interface";
import type { RequestContext, ResponseContext } from "../types";

/**
 * Minimal internal Subject shim used when rxjs is not available.
 * Provides: subscribe(fn) -> { unsubscribe }, next(value), complete()
 *
 * This generic shim is used by the adapter when a real rxjs.Subject is not
 * available. It is intentionally small and typed so the outer adapter can be
 * strongly-typed against the HypeEvent<TDetail> payload shape.
 */
class SimpleSubject<T> {
  private subs = new Set<(v: T) => void>();
  subscribe(fn: (v: T) => void) {
    this.subs.add(fn);
    return {
      unsubscribe: () => {
        try {
          this.subs.delete(fn);
        } catch {
          /* ignore */
        }
      },
    };
  }
  next(v: T) {
    // snapshot to avoid mutation during iteration
    const s = Array.from(this.subs);
    for (const fn of s) {
      try {
        fn(v);
      } catch {
        /* swallow handler errors */
      }
    }
  }
  complete() {
    try {
      this.subs.clear();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Try to obtain a runtime RxJS Subject/Observable if available.
 * We avoid static imports so this file compiles even when rxjs isn't installed.
 */
function tryGetRx() {
  try {
    // Try common global/module locations (bundlers vary). Use dynamic require if available.
    // @ts-ignore - dynamic access
    if (typeof (globalThis as any).require === "function") {
      try {
        // @ts-ignore
        const rx = (globalThis as any).require("rxjs");
        if (rx && rx.Subject && rx.Observable) return rx;
      } catch {
        // fallthrough
      }
    }
    // Check for a global rxjs namespace (uncommon)
    // @ts-ignore
    if ((globalThis as any).rxjs && (globalThis as any).rxjs.Subject) return (globalThis as any).rxjs;
  } catch {
    /* ignore */
  }
  return null;
}

export class RxEventSystem<TDetail = unknown> implements IEventSystem<TDetail> {
  private debug = false;
  // Subject-like source (either a real rxjs Subject or the internal SimpleSubject)
  // The emitted value shape is { name, element, detail: TDetail } to match the
  // IEventSystem/HypeEvent<TDetail> contract. This removes permissive `any` usage.
  private subject:
    | { subscribe: (fn: (v: { name: string; element: HTMLElement; detail: TDetail }) => void) => { unsubscribe: () => void }; next: (v: { name: string; element: HTMLElement; detail: TDetail }) => void; complete: () => void };

  // Optional injected rx namespace when building a static rx-bundled variant
  private rx?: any;

  private emitDom: boolean;

  /**
   * @param opts - options
   * @param opts.emitDom - when true (default) the adapter will also dispatch a DOM CustomEvent
   *                       on the provided element so existing DOM listeners continue to work.
   * @param opts.rx - optional injected rxjs namespace to prefer over runtime detection
   */
  constructor(opts: { emitDom?: boolean; rx?: any } = {}) {
    this.emitDom = opts.emitDom ?? true;

    // prefer explicit injection (opts.rx) when provided, otherwise fall back to runtime detection
    const runtimeRx = opts.rx ?? tryGetRx();
    this.rx = runtimeRx ?? undefined;

    if (runtimeRx && typeof runtimeRx.Subject === "function") {
      // @ts-ignore dynamic
      this.subject = new runtimeRx.Subject<{ name: string; element: HTMLElement; detail: TDetail }>();
    } else {
      // fallback to internal SimpleSubject shim
      this.subject = new SimpleSubject<{ name: string; element: HTMLElement; detail: TDetail }>();
    }
  }

  setDebug(debug: boolean): void {
    this.debug = !!debug;
  }

  // Strongly-typed detail generic instead of permissive `any`.
  dispatch(element: HTMLElement, eventName: string, detail?: TDetail): boolean {
    if (this.debug) {
      try {
        // eslint-disable-next-line no-console
        console.debug("[RxEventSystem] dispatch", eventName, { element: this.summary(element), detail });
      } catch {
        /* swallow logging failures */
      }
    }

    // Emit through Subject (synchronous by default)
    try {
      this.subject.next({ name: eventName, element, detail } as { name: string; element: HTMLElement; detail: TDetail });
    } catch {
      // swallow emission errors to avoid breaking app logic
    }

    // Optionally also dispatch a DOM CustomEvent so existing DOM listeners continue to work
    if (this.emitDom) {
      try {
        const ce = new CustomEvent(eventName, { detail: detail as any, bubbles: true, cancelable: true });
        // dispatchEvent returns false if preventDefault() was called
        return element.dispatchEvent(ce);
      } catch {
        // If dispatch fails for any reason, return true as a safe default (not prevented)
        return true;
      }
    }

    // If we're not emitting DOM events, return true (not prevented)
    return true;
  }

  /**
   * Returns an Observable-like (when Rx is available a real Observable should be
   * returned) that emits when the given eventName is dispatched. The emitted
   * value shape is: HypeEvent<TDetail> ({ element, detail }).
   */
  asObservable(eventName: string): ObservableLike<HypeEvent<TDetail>> {
    // If we have a real rxjs runtime, return a proper Observable using pipe/filter/map
    if (this.rx && typeof this.rx.Subject === "function" && typeof (this.subject as any).asObservable === "function") {
      try {
        const obs = (this.subject as any).asObservable();
        // Use rx operators if available (operators namespace)
        const ops = (this.rx && this.rx.operators) ? this.rx.operators : undefined;
        if (ops && typeof ops.filter === "function" && typeof ops.map === "function") {
          return obs.pipe(ops.filter((ev: any) => String(ev.name) === eventName), ops.map((ev: any) => ({ element: ev.element, detail: ev.detail })));
        }
        // If operators not present, return a mapped observable using `pipe` with inline functions if possible
        if (typeof obs.pipe === "function") {
          const rxjs = this.rx;
          // create filter and map using rxjs if available
          if (rxjs && rxjs.operators && typeof rxjs.operators.filter === "function") {
            return obs.pipe(rxjs.operators.filter((ev: any) => String(ev.name) === eventName), rxjs.operators.map((ev: any) => ({ element: ev.element, detail: ev.detail })));
          }
        }
        // Fallback: return raw observable; consumers can filter themselves
        return obs as ObservableLike<HypeEvent<TDetail>>;
      } catch {
        // fall through to non-rx fallback
      }
    }

    // Fallback: return a subscribable with subscribe(handler)
    return {
      subscribe: (handler: (payload: HypeEvent<TDetail>) => void) => {
        const sub = this.subject.subscribe((ev: { name: string; element: HTMLElement; detail: TDetail }) => {
          if (ev && String(ev.name) === eventName) {
            try {
              handler({ element: ev.element, detail: ev.detail });
            } catch {
              /* swallow handler errors */
            }
          }
        });
        return {
          unsubscribe: () => {
            try {
              sub.unsubscribe();
            } catch {
              /* ignore */
            }
          },
        };
      },
    };
  }

  /**
   * Return a lightweight subscribable for the given event name.
   *
   * If RxJS is present at runtime and subject is an Rx Subject/Observable,
   * consumers can still treat the returned object similarly to an RxJS
   * subscribable: it exposes `subscribe(handler)` which returns an object with
   * `unsubscribe()`. This keeps usage simple and avoids a hard runtime
   * dependency on rxjs.
   */
  on(eventName: string): ObservableLike<HypeEvent<TDetail>> {
    return {
      subscribe: (handler: (payload: HypeEvent<TDetail>) => void) => {
        const sub = this.subject.subscribe((ev: { name: string; element: HTMLElement; detail: TDetail }) => {
          if (ev && String(ev.name) === eventName) {
            try {
              handler({ element: ev.element, detail: ev.detail });
            } catch {
              /* swallow handler errors */
            }
          }
        });
        return {
          unsubscribe: () => {
            try {
              sub.unsubscribe();
            } catch {
              /* ignore */
            }
          },
        };
      },
    };
  }

  // Hype-specific lifecycle helpers that mirror the previous DOM CustomEvent helpers.
  // They dispatch the same named events and follow the same cancel semantics.
  dispatchBeforeRequest(ctx: RequestContext): RequestContext | null {
    let cancelled = false;
    // Build a lightweight detail payload and cast to TDetail so callers keep
    // a strongly-typed dispatch signature while we preserve the shape used here.
    const detail = { context: ctx, cancel: () => { cancelled = true; } } as unknown as TDetail;
    const notPrevented = this.dispatch(ctx.element, "hype:before-request", detail);
    if (!notPrevented || cancelled) return null;
    // `detail` may have been mutated by event listeners; attempt to return the context.
    // Use a best-effort access via a typed assertion.
    const asAny = detail as unknown as { context?: RequestContext };
    return asAny.context ?? ctx;
  }

  dispatchBeforeSwap(ctx: ResponseContext, html: string): string | null {
    let cancelled = false;
    const detail = { context: ctx, html, cancel: () => { cancelled = true; } } as unknown as TDetail;
    const notPrevented = this.dispatch(ctx.element, "hype:before-swap", detail);
    if (!notPrevented || cancelled) return null;
    const asAny = detail as unknown as { html?: string };
    return asAny.html ?? html;
  }

  dispatchAfterSwap(ctx: ResponseContext, target: HTMLElement): void {
    this.dispatch(ctx.element, "hype:after-swap", { context: ctx, target } as unknown as TDetail);
  }

  dispatchAfterSettle(ctx: ResponseContext, target: HTMLElement): void {
    this.dispatch(ctx.element, "hype:after-settle", { context: ctx, target } as unknown as TDetail);
  }

  dispatchRequestError(ctx: RequestContext, error: Error): void {
    this.dispatch(ctx.element, "hype:request-error", { context: ctx, error } as unknown as TDetail);
  }

  dispatchResponseError(ctx: ResponseContext, error: Error): void {
    this.dispatch(ctx.element, "hype:response-error", { context: ctx, error } as unknown as TDetail);
  }

  /**
   * Completes the underlying subject and releases subscriptions.
   * Hype should call destroy() when tearing down to avoid memory leaks.
   */
  destroy(): void {
    try {
      this.subject.complete();
    } catch {
      /* ignore */
    }
  }

  private summary(el: any) {
    try {
      if (!el || !el.tagName) return el;
      return {
        tag: String(el.tagName).toLowerCase(),
        id: el.id || undefined,
        classes: typeof el.className === "string" && el.className ? String(el.className).split(/\s+/) : undefined,
        dataset: el.dataset ? { ...el.dataset } : undefined,
      };
    } catch {
      return undefined;
    }
  }
}

export default RxEventSystem;