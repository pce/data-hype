/**
 * Lightweight pub/sub plugin for Hype
 *
 * Exports:
 *  - createHypePubsub(): { pub, sub }
 *  - attachToHype(hypeInstance): attaches pub/sub to an instance and returns { pub, sub, cleanup }
 *  - pubsubPlugin: plugin adapter with install(hypeInstance) -> cleanup
 *
 * Design:
 *  - Minimal, dependency-free. Intended to be JS-optional and unobtrusive.
 *  - Pub/Sub is added only when this module runs; HTML remains valid and functional without JavaScript.
 */

export type Unsubscribe = () => void;

export type PubFn = (topic: string, payload?: any) => void;
export type SubFn = (topic: string, handler: (payload?: any) => void) => Unsubscribe;

export function createHypePubsub(): { pub: PubFn; sub: SubFn } {
  const subs = new Map<string, Set<(payload?: any) => void>>();

  function sub(topic: string, handler: (payload?: any) => void): Unsubscribe {
    const set = subs.get(topic) || new Set();
    set.add(handler);
    subs.set(topic, set);
    return () => {
      const s = subs.get(topic);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) subs.delete(topic);
    };
  }

  function pub(topic: string, payload?: any) {
    const set = subs.get(topic);
    if (set) {
      // iterate over snapshot so handlers can unsubscribe safely
      const handlers = Array.from(set);
      for (const fn of handlers) {
        try {
          fn(payload);
        } catch (err) {
          // Surface in console but do not throw
          // eslint-disable-next-line no-console
          console.error("hype:pubsub handler error", err);
        }
      }
    }

    // Also emit a DOM CustomEvent for consumers that prefer DOM-based integration.
    try {
      const eventObj = new CustomEvent("hype:pub", {
        detail: { topic, payload },
        bubbles: true,
        composed: true,
      });
      // document may not exist in some environments; guard defensively
      if (typeof document !== "undefined" && document && typeof document.dispatchEvent === "function") {
        document.dispatchEvent(eventObj);
      }
    } catch {
      // ignore environments without CustomEvent or document
    }
  }

  return { pub, sub };
}

/**
 * Attach pub/sub methods to an existing Hype instance.
 * This mutates the instance by adding `.pub` and `.sub` properties.
 *
 * Returns an object with { pub, sub, cleanup } where cleanup removes the attached props.
 */
export function attachToHype(hypeInstance: any) {
  const ps = createHypePubsub();

  // attach non-enumerable where possible to minimize surface area
  try {
    Object.defineProperty(hypeInstance, "pub", {
      value: ps.pub,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  } catch {
    // fallback to simple assignment if defineProperty fails
    // eslint-disable-next-line no-param-reassign
    (hypeInstance as any).pub = ps.pub;
  }

  try {
    Object.defineProperty(hypeInstance, "sub", {
      value: ps.sub,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  } catch {
    // eslint-disable-next-line no-param-reassign
    (hypeInstance as any).sub = ps.sub;
  }

  const cleanup = () => {
    try {
      // prefer deleting the properties to restore original shape
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (hypeInstance as any).pub;
    } catch {
      /* ignore */
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (hypeInstance as any).sub;
    } catch {
      /* ignore */
    }
  };

  return { pub: ps.pub, sub: ps.sub, cleanup };
}

/**
 * Small plugin adapter so callers can `hype.attach(pubsubPlugin)` or `hype.init(pubsubPlugin)`.
 * The plugin installs pub/sub on the provided instance and returns a cleanup function.
 */
export const pubsubPlugin = {
  install(hypeInstance: any) {
    const attached = attachToHype(hypeInstance);
    return () => {
      try {
        attached.cleanup();
      } catch {
        /* ignore */
      }
    };
  },
};
