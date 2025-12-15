/**
 * Event system interface for Hype
 *
 * Defines the minimal contract that Hype expects from an event subsystem.
 * Concrete implementations (DOM CustomEvent-based, RxJS-backed adapter, or
 * test stubs) should implement this interface so they can be injected into
 * the Hype runtime.
 *
 * This version tightens the typing compared to the previous permissive shape:
 * - Event payloads are generic (`TDetail`) rather than `any`.
 * - The interface exposes an `asObservable`/`on` style API that can be used
 *   with Rx-like Observables. To avoid a hard dependency on RxJS here we
 *   declare a minimal `ObservableLike` shape that matches the usage Hype needs.
 *
 * If you build a static rx-bundled artifact you can map `ObservableLike` to
 * the real `Observable` type (or implement an adapter that returns a real
 * rxjs.Observable). This makes adapters strongly-typed in the rx-enabled path
 * while remaining implementable in environments without rxjs.
 */

import type {
  RequestContext,
  ResponseContext,
} from "../types";

/**
 * Minimal observable-like shape used by the event system contracts.
 *
 * When RxJS is available an adapter may return a real rxjs.Observable here.
 * For environments without rxjs the lightweight `subscribe`/`unsubscribe`
 * shape is sufficient for Hype's internal usage.
 */
export interface ObservableLike<T> {
  subscribe(next: (value: T) => void): { unsubscribe: () => void };
}

/**
 * Generic event payload wrapper emitted by the event system observables.
 * - `element` is the originating element for the event
 * - `detail` is the typed event payload
 */
export interface HypeEvent<TDetail = unknown> {
  element: HTMLElement;
  detail: TDetail;
}

/**
 * IEventSystem<TDetail>
 *
 * - TDetail: the shape of the `detail` payload carried with emitted events.
 *
 * Notes on init vs createHype and module vs IIFE:
 * - The runtime may be provided as a global (IIFE) or as an ES module factory.
 *   This interface focuses on the event surface and intentionally avoids
 *   any runtime-loading semantics here. Documentation/examples should explain:
 *     - use `window.hype.init()` for the legacy drop-in IIFE pattern.
 *     - prefer `createHype()` (module factory) for modern ESM/bundler setups.
 */
export interface IEventSystem<TDetail = unknown> {
  /**
   * Enable or disable debug logging for the event system.
   */
  setDebug(debug: boolean): void;

  /**
   * Dispatch a named event for a specific element.
   *
   * Returns true if the event was not cancelled (mirrors DOM CustomEvent semantics
   * where dispatchEvent returns false when preventDefault() was called).
   *
   * `detail` is strongly typed to `TDetail` to discourage arbitrary payloads.
   */
  dispatch(
    element: HTMLElement,
    eventName: string,
    detail?: TDetail,
  ): boolean;

  /**
   * Returns an Observable-like that emits for the given `eventName`.
   *
   * - When an adapter has RxJS available it may return a real rxjs.Observable<HypeEvent<TDetail>>.
   * - When RxJS is not present adapters can return an `ObservableLike<HypeEvent<TDetail>>`.
   *
   * This makes the event API directly usable with Rx operators in the rx-bundled path.
   */
  asObservable(eventName: string): ObservableLike<HypeEvent<TDetail>>;

  /**
   * Convenience: an `on` alias that returns a subscribable for an event.
   * Keeps a compact surface for consumers that don't need full rx operators.
   */
  on(eventName: string): ObservableLike<HypeEvent<TDetail>>;

  /**
   * Hype-specific lifecycle helpers used by the runtime.
   *
   * - dispatchBeforeRequest: called before performing a request. Return a
   *   (possibly modified) RequestContext or null to cancel the request.
   * - dispatchBeforeSwap: called before swapping HTML into a target. Return the
   *   (possibly modified) HTML string to continue or null to cancel.
   * - dispatchAfterSwap / dispatchAfterSettle: notify after swap/settle phases.
   * - dispatchRequestError / dispatchResponseError: notify about errors.
   */

  dispatchBeforeRequest(ctx: RequestContext): RequestContext | null;

  dispatchBeforeSwap(ctx: ResponseContext, html: string): string | null;

  dispatchAfterSwap(ctx: ResponseContext, target: HTMLElement): void;

  dispatchAfterSettle(ctx: ResponseContext, target: HTMLElement): void;

  dispatchRequestError(ctx: RequestContext, error: Error): void;

  dispatchResponseError(ctx: ResponseContext, error: Error): void;

  /**
   * Optional lifecycle cleanup for event system implementations that hold
   * subscriptions/resources (e.g. RxJS subjects). Implementations that don't
   * need cleanup may omit this method.
   */
  destroy?(): void;
}