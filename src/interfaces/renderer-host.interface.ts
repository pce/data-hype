/**
 * Renderer host interface and default DOM host implementation
 *
 * This file defines the minimal surface Hype needs from a renderer/host so
 * that the runtime can be adapted to non-browser environments (QuickJS + SDL2,
 * tests, etc.). It also provides a default DOM-based implementation which
 * preserves existing behavior for browser usage.
 *
 * The interface intentionally keeps the API small and focused on the operations
 * Hype currently needs: resolving a mount root, querying elements, wiring
 * events, dispatching custom events, reading/writing text, and a lightweight
 * idle scheduling primitive.
 */

export interface IRendererHost {
  /**
   * Resolve a "root" reference supplied by consumers into a concrete Element or
   * Document. Accepts:
   *  - Element -> returned as-is
   *  - Document -> returned as-is
   *  - selector string -> query against document
   *
   * Returns null when the root cannot be resolved.
   */
  resolveRoot(root: string | Element | Document): Element | Document | null;

  /**
   * Query a single descendant from the provided root.
   * Root may be Document or Element.
   */
  querySelector(root: Element | Document, selector: string): Element | null;

  /**
   * Query all matching descendants from the provided root. Returns a plain
   * array for ease of use in environments that don't support NodeList methods.
   */
  querySelectorAll(root: Element | Document, selector: string): Element[];

  /**
   * Add / remove event listeners on a target (Element or Document).
   */
  addEventListener(
    target: Element | Document,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;

  removeEventListener(
    target: Element | Document,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void;

  /**
   * Create and dispatch a Hype-style custom event. Implementations should set
   * sensible defaults for bubbles/cancelable so event-system behavior is
   * preserved when the host emits DOM events.
   *
   * Returns the boolean result of dispatch (mirrors Element.dispatchEvent).
   */
  createCustomEvent(name: string, detail?: unknown): CustomEvent;
  dispatchCustomEvent(target: Element, name: string, detail?: unknown): boolean;

  /**
   * Read / write element textual content. Hype uses innerText-like semantics
   * for a small set of features (indicators & labels).
   */
  setInnerText(element: Element, text: string): void;
  getInnerText(element: Element): string;

  /**
   * Lightweight idle scheduling primitive used by Hype to defer non-critical
   * work (reactive scan). Implementations may proxy to `requestIdleCallback`
   * when available or provide a fallback that behaves similarly.
   *
   * Returns a numeric handle compatible with `cancelIdleCallback`.
   */
  requestIdleCallback(callback: () => void, options?: { timeout?: number }): number;
  cancelIdleCallback(handle: number): void;
}

/**
 * Default DOM host implementation that delegates to standard browser APIs.
 *
 * This preserves the current behavior of Hype in browsers and can be injected
 * into the runtime via `createHype(..., host)`. Consumers who want to run Hype
 * in non-DOM environments should provide a different implementation that
 * conforms to `IRendererHost`.
 */
export class DefaultDomHost implements IRendererHost {
  resolveRoot(root: string | Element | Document): Element | Document | null {
    if (!root) return null;
    if (typeof root === "string") {
      return document.querySelector(root);
    }
    // Element or Document
    return root;
  }

  querySelector(root: Element | Document, selector: string): Element | null {
    try {
      if ((root as Document).querySelector) {
        return (root as Document).querySelector(selector);
      }
      return null;
    } catch {
      return null;
    }
  }

  querySelectorAll(root: Element | Document, selector: string): Element[] {
    try {
      if ((root as Document).querySelectorAll) {
        const nodeList = (root as Document).querySelectorAll(selector);
        return Array.from(nodeList) as Element[];
      }
      return [];
    } catch {
      return [];
    }
  }

  addEventListener(
    target: Element | Document,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    try {
      (target as Element | Document).addEventListener(type, listener as EventListener, options);
    } catch {
      // best-effort: swallow to avoid hard failures in environments with
      // partial DOM shims
    }
  }

  removeEventListener(
    target: Element | Document,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    try {
      (target as Element | Document).removeEventListener(type, listener as EventListener, options);
    } catch {
      /* no-op */
    }
  }

  createCustomEvent(name: string, detail?: unknown): CustomEvent {
    try {
      return new CustomEvent(name, { detail, bubbles: true, cancelable: true });
    } catch {
      // In very constrained hosts CustomEvent ctor may be absent; provide a
      // minimal polyfill object that matches the shape used by `dispatchCustomEvent`.
      const fake: any = {
        type: name,
        detail,
        bubbles: true,
        cancelable: true,
      };
      return fake as CustomEvent;
    }
  }

  dispatchCustomEvent(target: Element, name: string, detail?: unknown): boolean {
    const ev = this.createCustomEvent(name, detail);
    try {
      return target.dispatchEvent(ev);
    } catch {
      // If dispatchEvent is not available, return true to indicate "not cancelled"
      // (safe default).
      return true;
    }
  }

  setInnerText(element: Element, text: string): void {
    try {
      // Prefer innerText for behavior closest to user-visible text; fallback to textContent.
      (element as HTMLElement).innerText = text;
    } catch {
      try {
        element.textContent = text;
      } catch {
        /* ignore */
      }
    }
  }

  getInnerText(element: Element): string {
    try {
      const el = element as HTMLElement;
      return (el.innerText ?? el.textContent ?? "") as string;
    } catch {
      return "";
    }
  }

  requestIdleCallback(callback: () => void, options?: { timeout?: number }): number {
    // Use native if available, otherwise fall back to setTimeout.
    const win = typeof window !== "undefined" ? (window as any) : undefined;
    if (win && typeof win.requestIdleCallback === "function") {
      return win.requestIdleCallback(callback, options);
    }
    // setTimeout returns a number in browsers; keep the same shape.
    return window.setTimeout(callback, 0);
  }

  cancelIdleCallback(handle: number): void {
    const win = typeof window !== "undefined" ? (window as any) : undefined;
    if (win && typeof win.cancelIdleCallback === "function") {
      win.cancelIdleCallback(handle);
      return;
    }
    clearTimeout(handle);
  }
}

/**
 * Convenience default instance for consumers who want the standard browser host.
 */
export const defaultDomHost = new DefaultDomHost();

/**
 * Type alias for consumers who want to import the instance/class type for
 * typing purposes (import type { DefaultDomHostInstance } from ...).
 *
 * Note: the class `DefaultDomHost` remains a named export and a default export,
 * this alias provides an explicit type-only export to avoid accidental value
 * imports when consumers only need the type.
 */
export type DefaultDomHostInstance = DefaultDomHost;

export default DefaultDomHost;