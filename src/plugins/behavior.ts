/**
 * Behavior registry, trigger parsing, and debounce wiring for Hype.
 *
 * Exports:
 *  - createBehaviorRegistry(defaultAction?)
 *  - parseTriggerSpec(raw)
 *  - attachBehaviorsFromAttribute(root?, registry?, hype?, attrName?)
 *  - attachDebounce(root?, hype?, attrName?)
 *  - behaviorPlugin
 *
 * JS-optional design:
 * - `data-*` attributes are valid HTML and have no effect when JavaScript is not running
 * - behavior wiring is activated only when this module is loaded/executed in the page
 */

export type Unsubscribe = () => void;
export type BehaviorAttach = (el: HTMLElement, spec: BehaviorSpec) => Unsubscribe;

export interface BehaviorSpec {
  name: string;
  param?: string | null;
  repeat?: boolean;
  raw?: string;
  data?: Record<string, unknown>;
}

/**
 * Minimal behavior implementation interface
 */
interface BehaviorImpl {
  attach: BehaviorAttach;
}

/**
 * Create a behavior registry with useful built-ins:
 *  - click: listen for click and call action
 *  - revealed: IntersectionObserver, fires when element enters view
 *  - interval: runs action on interval param (ms)
 *  - scroll-bottom: fires when scroll container near bottom
 *  - select: set a target input value from a suggestion list item
 *
 * Consumers can register more with `register(name, impl)`.
 */
export function createBehaviorRegistry(defaultAction?: (el: HTMLElement, spec: BehaviorSpec) => void) {
  const registry = new Map<string, BehaviorImpl>();

  const action =
    defaultAction ||
    ((el: HTMLElement, _spec?: BehaviorSpec) => {
      // best-effort: dispatch a custom event that Hype or other consumers can catch
      const eventObj = new CustomEvent("hype:behavior-trigger", { detail: { el, spec: _spec }, bubbles: true, composed: true });
      el.dispatchEvent(eventObj);
      return eventObj;
    });

  // click behavior
  registry.set("click", {
    attach(el: HTMLElement, spec: BehaviorSpec) {
      const handler = (_ev: Event) => {
        // allow default to run, then invoke action
        action(el, spec);
      };
      el.addEventListener("click", handler);
      return () => el.removeEventListener("click", handler);
    },
  });

  // revealed behavior (IntersectionObserver) - useful for infinite-scroll sentinel
  //
  // Note: configurable via data attributes. Supported keys include:
  // data-hype-root, data-hype-edge, data-hype-direction, data-hype-once,
  // data-hype-threshold, and data-hype-root-margin. The observed element
  // (`el`) is the default context; `data-hype-root="this"` binds the observer
  // root to the element itself when appropriate. When triggered, `spec.data`
  // is enriched with metadata so actions or consumers can decide how to
  // prepend/append and whether to preserve scroll position.
  // observer root to the element itself when appropriate. On trigger we add
  // metadata into `spec.data` so the default action (or consumer handlers)
  // can decide whether to prepend/append and how to preserve scroll position.
  registry.set("revealed", {
    attach(el: HTMLElement, spec: BehaviorSpec) {
      // Read configuration from data attributes (sane defaults?)
      const rootAttr = el.getAttribute("data-hype-root");
      const edgeAttr = el.getAttribute("data-hype-edge"); // top|bottom|left|right
      const dirAttr = el.getAttribute("data-hype-direction"); // up|down|left|right|both
      const onceAttr = el.getAttribute("data-hype-once"); // "true" => observe once
      const thresholdAttr = el.getAttribute("data-hype-threshold"); // number or CSV of numbers
      const rootMarginAttr = el.getAttribute("data-hype-root-margin"); // e.g. "0px 0px 200px 0px"

      // Determine the root for the IntersectionObserver.
      // If rootAttr === 'this', bind root to the element itself.
      // If a selector is provided, resolve it; otherwise choose the nearest scrollable ancestor
      // (if that ancestor is the window, use null to indicate viewport).
      let root: Element | null = null;
      if (rootAttr === "this") {
        root = el;
      } else if (rootAttr) {
        try {
          const q = document.querySelector(rootAttr);
          if (q instanceof Element) root = q;
        } catch {
          root = null;
        }
      } else {
        const scrollable = findScrollableAncestor(el);
        root = scrollable instanceof Window ? null : (scrollable as Element);
      }

      // Parse threshold
      let threshold: number | number[] = 0.1;
      if (thresholdAttr) {
        const parts = thresholdAttr
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => !Number.isNaN(n));
        threshold = parts.length === 1 ? parts[0] || 0 : parts.length ? parts : 0.1;
      }

      const rootMargin = rootMarginAttr || "0px 0px 0px 0px";

      // onceAttr="true" -> observe once => repeat=false; else honor spec.repeat if provided
      const repeat = typeof onceAttr === "string" ? !(onceAttr === "true") : !(spec.repeat ?? false);

      const opts: IntersectionObserverInit = {
        root,
        threshold,
        rootMargin,
      };

      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // enrich spec.data with metadata so actions can prepend/append/preserve-scroll
            spec.data = {
              ...(spec.data || {}),
              edge: edgeAttr || null,
              direction: dirAttr || null,
              rootSelector: rootAttr || null,
              intersection: {
                ratio: entry.intersectionRatio,
                boundingClientRect: entry.boundingClientRect ? { width: entry.boundingClientRect.width, height: entry.boundingClientRect.height } : undefined,
              },
            };

            action(el, spec);

            if (!repeat) {
              try {
                io.unobserve(el);
              } catch {
                /* ignore unobserve errors */
              }
            }
          }
        }
      }, opts);

      // Observe the sentinel element
      io.observe(el);

      // Return cleanup
      return () => {
        try {
          io.disconnect();
        } catch {
          /* ignore */
        }
      };
    },
  });

  // interval behavior - param required (ms)
  registry.set("interval", {
    attach(el: HTMLElement, spec: BehaviorSpec) {
      const ms = Number(spec.param || "1000") || 1000;
      const id = setInterval(() => {
        action(el, spec);
      }, ms);
      return () => clearInterval(id);
    },
  });

  // scroll-bottom behavior - fires when container scrolled near bottom
  registry.set("scroll-bottom", {
    attach(el: HTMLElement, spec: BehaviorSpec) {
      const threshold = Number(spec.param || "200") || 200;
      // find scrollable ancestor or window
      const scrollable = findScrollableAncestor(el) || window;
      const handler = () => {
        const { scrollTop, scrollHeight, clientHeight } = getScrollMetrics(scrollable);
        if (scrollHeight - (scrollTop + clientHeight) <= threshold) {
          action(el, spec);
          if (!spec.repeat) {
            // remove handler by returning cleanup
            remove();
          }
        }
      };
      const remove = () => {
        if (scrollable instanceof Window) {
          window.removeEventListener("scroll", handler);
        } else {
          (scrollable as Element).removeEventListener("scroll", handler);
        }
      };
      if (scrollable instanceof Window) {
        window.addEventListener("scroll", handler);
      } else {
        (scrollable as Element).addEventListener("scroll", handler);
      }
      // run immediately in case already near bottom
      handler();
      return remove;
    },
  });

  // select behavior - useful for suggestion lists: on click, set target input value and dispatch input event
  registry.set("select", {
    attach(el: HTMLElement, _spec: BehaviorSpec) {
      const handler = () => {
        // prefer explicit attributes first, fall back to sensible defaults
        const targetSelector = el.getAttribute("data-select-target") || el.getAttribute("data-hype-select-target") || el.getAttribute("data-select-for");
        const rawValue =
          el.getAttribute("data-select-value") ??
          el.getAttribute("data-hype-select-value") ??
          el.getAttribute("data-value") ??
          (el.textContent ? el.textContent.trim() : "");
        if (!targetSelector) return;
        const input = document.querySelector(targetSelector) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!input) return;
        // set value and dispatch input so Hype/other listeners pick it up
        try {
          (input as HTMLInputElement).value = rawValue as string;
        } catch {
          // ignore if not a value-bearing element
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      el.addEventListener("click", handler);
      return () => el.removeEventListener("click", handler);
    },
  });

  function register(name: string, impl: BehaviorImpl) {
    registry.set(name, impl);
    return () => registry.delete(name);
  }

  function get(name: string) {
    return registry.get(name);
  }

  return { register, get, action };
}

/* -------------------------------
 * Helpers used by behaviors
 * ------------------------------- */

function findScrollableAncestor(el: HTMLElement | null): Element | Window | null {
  if (!el) return window;
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return window;
}

function getScrollMetrics(target: Element | Window) {
  if (target instanceof Window) {
    return {
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
    };
  } else {
    return {
      scrollTop: (target as Element).scrollTop,
      scrollHeight: (target as Element).scrollHeight,
      clientHeight: (target as Element).clientHeight,
    };
  }
}

/* -------------------------------
 * Trigger parsing and wiring
 * ------------------------------- */

/**
 * Parse a trigger string into BehaviorSpec.
 * Examples:
 *  - "revealed"
 *  - "interval:5000"
 *  - "scroll-bottom:300:repeat"
 */
export function parseTriggerSpec(raw: string): BehaviorSpec[] {
  if (!raw) return [];
  // allow multiple triggers separated by semicolon or pipe or comma
  const parts = raw.split(/\s*[;,|]\s*/).filter(Boolean);
  const specs: BehaviorSpec[] = parts.map((p) => {
    const rawTrim = p.trim();
    const segments = rawTrim.split(":");
    const name = segments[0] || "";
    const param = segments[1] ?? null;
    // consider any subsequent segments for a 'repeat' flag, or explicit trailing :repeat
    const repeat = segments.slice(2).includes("repeat") || rawTrim.endsWith(":repeat");
    return { name, param, repeat, raw: rawTrim };
  });
  return specs;
}

/**
 * Scans `root` for elements with `attrName` (default `data-hype-trigger`)
 * and uses the given registry to attach behaviors. If `hype` is provided,
 * it will be passed to default action invocations (if defaultAction uses it).
 *
 * Returns a cleanup function that removes all attached handlers and the MutationObserver.
 */
export function attachBehaviorsFromAttribute(
  root: ParentNode = document,
  registry?: ReturnType<typeof createBehaviorRegistry>,
  hype?: any,
  attrName = "data-hype-trigger",
) {
  const reg =
    registry ||
    createBehaviorRegistry((el, spec) => {
      // if a Hype instance is provided, prefer using its trigger API
      if (hype && typeof hype.trigger === "function") {
        try {
          hype.trigger(el).catch(() => {
            /* swallow */
          });
        } catch {
          /* swallow */
        }
      } else {
        // dispatch a custom event Hype can listen for
        const eventObj = new CustomEvent("hype:trigger", { detail: { spec }, bubbles: true, composed: true });
        el.dispatchEvent(eventObj);
      }
    });

  const cleanups = new Map<HTMLElement, Unsubscribe[]>();

  function wireElement(el: HTMLElement) {
    const raw = el.getAttribute(attrName);
    if (!raw) return;

    // Automatically add a sane default debounce for interactive inputs when triggers are present,
    // unless a debounce attribute is explicitly set to '0' (disabled) or another value.
    // Derive debounce attribute name from trigger attribute name (e.g. data-hype-trigger -> data-hype-debounce)
    const debounceAttr = attrName.endsWith("-trigger") ? attrName.replace(/-trigger$/, "-debounce") : "data-hype-debounce";

    // Collect candidate input-like elements: the element itself if applicable, and any nested inputs
    const inputs: HTMLElement[] = [];
    try {
      if (el.matches && el.matches("input,textarea,select,[contenteditable]")) {
        inputs.push(el);
      }
    } catch {
      // el.matches may throw in some contexts; ignore
    }
    // find nested interactive elements
    el.querySelectorAll?.("input,textarea,select,[contenteditable]").forEach((n: Element) => {
      inputs.push(n as HTMLElement);
    });

    for (const inputEl of inputs) {
      // Do not overwrite an explicit attribute. If attribute exists and is '0', respect it as disabled.
      if (!inputEl.hasAttribute(debounceAttr)) {
        // default debounce 300ms; set to '0' to opt-out
        inputEl.setAttribute(debounceAttr, "300");
      }
    }

    const specs = parseTriggerSpec(raw);
    const unsubList: Unsubscribe[] = [];
    for (const spec of specs) {
      const impl = reg.get(spec.name);
      if (!impl) continue;
      const unsub = impl.attach(el, spec);
      if (typeof unsub === "function") unsubList.push(unsub);
    }
    if (unsubList.length) cleanups.set(el, unsubList);
  }

  // initial scan
  const els = Array.from((root as Element).querySelectorAll?.(`[${attrName}]`) || []);
  // include root itself if it is an Element and has the attribute
  if (root instanceof Element && root.hasAttribute(attrName)) els.unshift(root);
  for (const n of els) {
    wireElement(n as HTMLElement);
  }

  // observe dynamic additions
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.hasAttribute && node.hasAttribute(attrName)) {
          wireElement(node as HTMLElement);
        }
        const children = node.querySelectorAll?.(`[${attrName}]`) || [];
        children.forEach((c: Element) => wireElement(c as HTMLElement));
      }
    }
  });

  if (typeof (root as Element).querySelectorAll === "function") {
    observer.observe(root as Element, { childList: true, subtree: true });
  } else {
    // if root is document, observe document.body
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return () => {
    observer.disconnect();
    // run all unsubscribers
    cleanups.forEach((arr: Unsubscribe[]) =>
      arr.forEach((fn: Unsubscribe) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }),
    );
    cleanups.clear();
  };
}

/* -------------------------------
 * Debounce wiring
 * ------------------------------- */

/**
 * Attach debounced input behavior for inputs marked with `data-hype-debounce`.
 * - Reads ms from attribute value (e.g. data-hype-debounce="300")
 * - On `input`, schedules a debounced dispatch of `hype:debounced-input` on the element.
 * - If a Hype instance is provided, it will also call `hype.trigger(el)` when debounce fires.
 *
 * Returns an unsubscribe function to remove observers/listeners.
 */
export function attachDebounce(root: ParentNode = document, hype?: any, attrName = "data-hype-debounce") {
  const handlers = new Map<HTMLElement, () => void>();
  const timers = new Map<HTMLElement, number | null>();

  function wire(el: HTMLElement) {
    if (handlers.has(el)) return;
    const raw = el.getAttribute(attrName);
    if (!raw) return;
    const ms = Number(raw) || 300;
    let timer: number | null = null;

    const onInput = (ev: Event) => {
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        // dispatch a custom event that Hype or other listeners can use
        const ev2 = new CustomEvent("hype:debounced-input", {
          detail: { originalEvent: ev },
          bubbles: true,
          composed: true,
        });
        el.dispatchEvent(ev2);

        // also trigger Hype if available (best-effort)
        if (hype && typeof hype.trigger === "function") {
          // ignore returned promise
          try {
            hype.trigger(el).catch(() => {
              /* swallow */
            });
          } catch {
            /* swallow */
          }
        }

        timer = null;
      }, ms);
      timers.set(el, timer);
    };

    el.addEventListener("input", onInput);
    handlers.set(el, () => {
      el.removeEventListener("input", onInput);
      const t = timers.get(el);
      if (t) window.clearTimeout(t);
      timers.delete(el);
    });
  }

  // initial scan
  const initial = Array.from((root as Element).querySelectorAll?.(`[${attrName}]`) || []);
  if (root instanceof Element && root.hasAttribute(attrName)) initial.unshift(root);
  for (const el of initial) wire(el as HTMLElement);

  // observe new elements
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.hasAttribute && node.hasAttribute(attrName)) wire(node as HTMLElement);
        node.querySelectorAll?.(`[${attrName}]`)?.forEach((c: Element) => wire(c as HTMLElement));
      }
    }
  });

  try {
    if (typeof (root as Element).querySelectorAll === "function") {
      observer.observe(root as Element, { childList: true, subtree: true });
    } else {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } catch {
    // ignore observation errors (non-browser environments)
  }

  return () => {
    observer.disconnect();
    handlers.forEach((unsub: () => void, _el: HTMLElement) => {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    });
    handlers.clear();
    timers.clear();
  };
}

/* -------------------------------
 * Hype plugin adapter
 * ------------------------------- */

/**
 * Behavior plugin: installs behavior registry + debounce wiring tied to a Hype instance.
 *
 * Usage:
 *   hype.attach(behaviorPlugin)
 * or
 *   hype.init(behaviorPlugin)
 *
 * The plugin returns a cleanup function that removes observers and handlers.
 */
export const behaviorPlugin = {
  install(hypeInstance: any) {
    const prefix = hypeInstance && typeof hypeInstance.getConfig === "function" ? hypeInstance.getConfig().attributePrefix : "hype";

    const triggerAttr = `data-${prefix}-trigger`;
    const debounceAttr = `data-${prefix}-debounce`;

    // create a registry where the default action will try to call hype.trigger
    const registry = createBehaviorRegistry((el: HTMLElement, spec: BehaviorSpec) => {
      if (hypeInstance && typeof hypeInstance.trigger === "function") {
        try {
          hypeInstance.trigger(el).catch(() => {
            /* swallow */
          });
        } catch {
          /* swallow */
        }
      } else {
        const ev = new CustomEvent("hype:behavior-trigger", { detail: { el, spec }, bubbles: true, composed: true });
        el.dispatchEvent(ev);
      }
    });

    // attach behavior wiring and debounce wiring
    const cleanupBeh = attachBehaviorsFromAttribute(document.body, registry, hypeInstance, triggerAttr);
    const cleanupDeb = attachDebounce(document.body, hypeInstance, debounceAttr);

    // plugin cleanup
    return () => {
      try {
        cleanupBeh();
      } catch {
        /* ignore */
      }
      try {
        cleanupDeb();
      } catch {
        /* ignore */
      }
    };
  },
};
