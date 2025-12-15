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

const debounceRegistry: WeakMap<ParentNode, Map<string, any>> = new WeakMap<ParentNode, Map<string, any>>();
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
  // Optional Hype instance reference that behaviors can prefer over global hooks.
  // Use `setHypeInstance(h)` to inject the Hype instance into this registry so
  // behavior implementations can call instance helpers (e.g. trigger, templateClone).
  let hypeInstanceRef: any = null;
  function setHypeInstance(h: any) {
    hypeInstanceRef = h;
  }

  const action =
    defaultAction ||
    ((el: HTMLElement, _spec?: BehaviorSpec) => {
      // If a Hype instance has been provided, prefer calling its trigger API (best-effort).
      if (hypeInstanceRef && typeof hypeInstanceRef.trigger === "function") {
        try {
          // ignore returned promise - behavior trigger should be best-effort
          hypeInstanceRef.trigger(el).catch(() => {
            /* swallow */
          });
        } catch {
          /* swallow */
        }
        // allow implementations to rely on the Hype trigger; also dispatch event for non-Hype listeners
      }

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

  // interval behavior - run an action on a schedule (ms)
  registry.set("interval", {
    attach(el: HTMLElement, spec: BehaviorSpec) {
      const ms = Number(spec.param || "1000") || 1000;
      const id = window.setInterval(() => {
        try {
          action(el, spec);
        } catch {
          /* ignore action errors */
        }
      }, ms);
      return () => {
        try {
          clearInterval(id);
        } catch {
          /* ignore clear errors */
        }
      };
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

  // snap behavior - useful for scroll-snap containers: sets --active-index and supports next/prev controls
  //
  // Usage examples:
  //  - add `data-hype-trigger="snap"` on a scroll container whose immediate children are snap points
  //  - optionally configure `data-hype-root` to target a different IntersectionObserver root
  //  - add controls like `<button data-hype-snap-next data-hype-snap-target="#myContainer">Next</button>`
  //    or `<button data-hype-snap-prev data-hype-snap-target="#myContainer">Prev</button>`
  //
  // This behavior will:
  //  - observe children and compute the most visible child, set CSS var `--active-index` and `data-hype-active-index`
  //  - support next/prev controls that scroll to the next/previous snap child
  registry.set("snap", {
    attach(container: HTMLElement, _spec: BehaviorSpec) {
      // identify children that are snap items (immediate element children)
      const children = Array.from(container.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
      if (!children.length) return () => {};

      // resolve root similar to revealed behavior
      const rootAttr = container.getAttribute("data-hype-root");
      let root: Element | null = null;
      if (rootAttr === "this") {
        root = container;
      } else if (rootAttr) {
        try {
          const q = document.querySelector(rootAttr);
          if (q instanceof Element) root = q;
        } catch {
          root = null;
        }
      } else {
        const scrollable = findScrollableAncestor(container);
        root = scrollable instanceof Window ? null : (scrollable as Element);
      }

      // observer options: use a reasonable threshold array to measure visibility
      const opts: IntersectionObserverInit = {
        root,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      };

      let activeIndex = Number(container.dataset.hypeActiveIndex || 0);

      const updateActive = (index: number) => {
        if (index === activeIndex) return;
        activeIndex = index;
        try {
          container.style.setProperty("--active-index", String(index));
        } catch {
          /* ignore */
        }
        try {
          container.dataset.hypeActiveIndex = String(index);
        } catch {
          /* ignore */
        }

        // Dispatch a small, semantic event so consumers can react (and to allow
        // Hype-specific wiring to update stateful UI without polling). Event
        // detail contains the new active index.
        try {
          const ev = new CustomEvent("hype:snap-change", { detail: { index }, bubbles: true, composed: true });
          container.dispatchEvent(ev);
        } catch {
          /* ignore */
        }

        // Convenience: update any declarative display elements that opt-in via
        // `data-hype-snap-display`. If an element has `data-hype-snap-target`,
        // only update it when the target matches this container.
        try {
          document.querySelectorAll("[data-hype-snap-display]").forEach((d) => {
            try {
              const displayEl = d as HTMLElement;
              const targetSel = displayEl.getAttribute("data-hype-snap-target");
              if (!targetSel) {
                displayEl.textContent = String(index);
                return;
              }
              // resolve selector and compare to this container
              let resolved: Element | null = null;
              try {
                resolved = document.querySelector(targetSel);
              } catch {
                resolved = null;
              }
              if (resolved === container) {
                displayEl.textContent = String(index);
              }
            } catch {
              /* ignore per-item failures */
            }
          });
        } catch {
          /* ignore update errors */
        }
      };

      const io = new IntersectionObserver((entries) => {
        // compute the child with the greatest intersectionRatio
        const scores = new Map<HTMLElement, number>();
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          scores.set(target, entry.intersectionRatio || 0);
        }
        // include children that might not be in the current entries
        let bestIndex = activeIndex;
        let bestScore = -1;
        children.forEach((child, idx) => {
          const s = scores.has(child) ? (scores.get(child) as number) : 0;
          if (s > bestScore) {
            bestScore = s;
            bestIndex = idx;
          }
        });
        updateActive(bestIndex);
      }, opts);

      // observe all children
      children.forEach((c) => io.observe(c));

      // next/prev controls: listen for clicks on document for elements carrying the control attributes
      const onDocClick = (ev: Event) => {
        const t = ev.target as HTMLElement | null;
        if (!t) return;
        const ctrl = t.closest("[data-hype-snap-next],[data-hype-snap-prev]") as HTMLElement | null;
        if (!ctrl) return;
        const targetSelector = ctrl.getAttribute("data-hype-snap-target");
        if (targetSelector) {
          // control targets a specific container
          const targetEl = document.querySelector(targetSelector);
          if (targetEl !== container) return;
        } else {
          // no explicit target: ensure control is inside container or document-level controls are allowed
          if (!container.contains(ctrl)) return;
        }
        const dir = ctrl.hasAttribute("data-hype-snap-next") ? 1 : -1;
        const cur = Number(container.dataset.hypeActiveIndex || 0);
        const nextIdx = Math.max(0, Math.min(children.length - 1, cur + dir));
        const nextEl = children[nextIdx];
        if (nextEl && typeof (nextEl as HTMLElement).scrollIntoView === "function") {
          try {
            nextEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" } as ScrollIntoViewOptions);
          } catch {
            try {
              nextEl.scrollIntoView();
            } catch {
              /* ignore */
            }
          }
          updateActive(nextIdx);
        }
      };

      document.addEventListener("click", onDocClick);

      // cleanup
      return () => {
        try {
          io.disconnect();
        } catch {
          /* ignore */
        }
        try {
          document.removeEventListener("click", onDocClick);
        } catch {
          /* ignore */
        }
      };
    },
  });

  // infinite behavior - sentinel-driven infinite loader using templateClone and a tiny flyweight pool
  //
  // Usage:
  //  - add `data-hype-trigger="infinite:8"` (param = items per page)
  //  - configure attributes on the sentinel:
  //      data-hype-get="/api/images?page={page}"   (optional; if absent, synthetic placeholder items are created)
  //      data-hype-target="#imageGrid"
  //      data-hype-template="#photo-tpl"
  //      data-hype-root-margin="0px 0px 400px 0px"
  //
  // The behavior will:
  //  - observe the sentinel element (the element carrying the trigger)
  //  - when visible, fetch JSON or HTML from `data-hype-get` (if provided)
  //  - use a template (via `window.hype.templateClone` if available, otherwise native cloning) to render items
  //  - maintain a small flyweight pool to reduce DOM churn when possible
  registry.set("infinite", {
    attach(el: HTMLElement, spec: BehaviorSpec) {
      const perPage = Number(spec.param || el.getAttribute("data-hype-per-page") || "8") || 8;
      const urlTemplate = el.getAttribute("data-hype-get") || "";
      const targetSelector = el.getAttribute("data-hype-target") || el.getAttribute("data-target") || null;
      const tplSelector = el.getAttribute("data-hype-template") || el.getAttribute("data-template") || null;
      const rootMargin = el.getAttribute("data-hype-root-margin") || "0px 0px 400px 0px";
      const poolSize = Math.max(0, Number(el.getAttribute("data-hype-pool-size") || "12") || 12);

      let page = Number(el.getAttribute("data-hype-start-page") || "1") || 1;
      let loading = false;
      let ended = false;

      // small flyweight pool of detached nodes created from template for reuse
      const pool: HTMLElement[] = [];

      function makeFromTemplate(data: any): HTMLElement | null {
        try {
          // prefer an injected Hype instance helper (templateClone) if provided via setHypeInstance()
          const globalTplClone =
            typeof hypeInstanceRef === "object" && typeof (hypeInstanceRef as any).templateClone === "function"
              ? (hypeInstanceRef as any).templateClone.bind(hypeInstanceRef)
              : null;
          if (globalTplClone && tplSelector) {
            const node = globalTplClone(tplSelector, data);
            if (node instanceof HTMLElement) return node as HTMLElement;
            if (node && node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
              return (node as DocumentFragment).firstElementChild as HTMLElement | null;
            }
          }

          // fallback: DOM cloning from template element
          if (tplSelector) {
            const tpl = document.querySelector(tplSelector) as HTMLTemplateElement | null;
            if (tpl && tpl.content) {
              const frag = tpl.content.cloneNode(true) as DocumentFragment;
              // simple interpolation for attributes and text nodes: {{key}}
              const interpolate = (str: string) =>
                String(str).replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, key) => {
                  const parts = key.split(".");
                  let v: any = data;
                  for (const p of parts) {
                    if (v == null) return "";
                    v = v[p];
                  }
                  return v == null ? "" : String(v);
                });
              const walker = (node: Node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                  node.textContent = interpolate(node.textContent || "");
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                  const ae = node as Element;
                  for (const at of Array.from(ae.attributes || [])) {
                    const nv = interpolate(at.value);
                    if (nv !== at.value) ae.setAttribute(at.name, nv);
                  }
                  for (const c of Array.from(ae.childNodes || [])) walker(c);
                }
              };
              for (const cn of Array.from(frag.childNodes)) walker(cn);
              return frag.firstElementChild as HTMLElement | null;
            }
          }

          // last resort: create a minimal element if data has src/alt
          if (data && (data.src || data.id)) {
            const li = document.createElement("li");
            li.className = "item";
            const img = document.createElement("img");
            img.src = data.src || `https://picsum.photos/id/${data.id}/800/533`;
            img.alt = data.alt || `Image ${data.id || ""}`;
            li.appendChild(img);
            return li;
          }

          return null;
        } catch (err) {
          // swallow template errors and return null
          return null;
        }
      }

      function applyDataToNode(node: HTMLElement, data: any) {
        // try to update common image attributes quickly
        try {
          const img = node.querySelector("img");
          if (img && data) {
            if (data.src) img.setAttribute("src", String(data.src));
            if (data.alt) img.setAttribute("alt", String(data.alt));
          }
        } catch {
          // ignore
        }
      }

      function appendItems(items: any[]) {
        const target = targetSelector ? document.querySelector(targetSelector) : el.parentElement || document.body;
        if (!target) return;
        const frag = document.createDocumentFragment();

        for (const it of items) {
          let node: HTMLElement | null = null;
          if (pool.length > 0) {
            node = pool.pop() as HTMLElement;
            applyDataToNode(node, it);
          } else {
            node = makeFromTemplate(it);
          }
          if (node) frag.appendChild(node);
        }

        target.appendChild(frag);

        // warm the pool if a template exists and pool is not yet full
        if (tplSelector) {
          const tpl = document.querySelector(tplSelector) as HTMLTemplateElement | null;
          while (tpl && pool.length < poolSize && tpl.content && tpl.content.firstElementChild) {
            const clone = tpl.content.firstElementChild.cloneNode(true) as HTMLElement;
            // clear any content for reuse
            try {
              const img = clone.querySelector("img");
              if (img) {
                img.removeAttribute("src");
                img.removeAttribute("alt");
              }
            } catch {}
            pool.push(clone);
          }
        }
      }

      async function doLoad() {
        if (loading || ended) return;
        loading = true;
        try {
          if (urlTemplate && urlTemplate.includes("{page}")) {
            const url = urlTemplate.replace("{page}", String(page));
            const res = await fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (!res.ok) {
              // consider ending on non-OK to avoid spamming
              ended = true;
              return;
            }
            const ct = (res.headers.get("Content-Type") || "").toLowerCase();
            if (ct.includes("application/json")) {
              const json = await res.json();
              if (Array.isArray(json)) appendItems(json);
              else if (json && Array.isArray(json.items)) appendItems(json.items);
              else {
                // unknown shape: attempt to render nothing and end
                ended = true;
              }
            } else {
              // HTML fragment - insert directly into target
              const html = await res.text();
              const target = targetSelector ? document.querySelector(targetSelector) : el.parentElement || document.body;
              if (target) {
                const frag = document.createRange().createContextualFragment(html);
                target.appendChild(frag);
              }
            }
          } else {
            // fallback synthetic generation
            const base = (page - 1) * perPage;
            const ids = Array.from({ length: perPage }, (_, i) => 101 + ((base + i) % 100));
            const arr = ids.map((id) => ({ id, src: `https://picsum.photos/id/${id}/800/533`, alt: `Image ${id}` }));
            appendItems(arr);
          }
          page++;
        } catch (err) {
          // network/render error -> end the sequence to avoid retries; consumer can add retry behavior
          ended = true;
        } finally {
          loading = false;
        }
      }

      // Observe sentinel
      let io: IntersectionObserver | null = null;
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver(
          (entries) => {
            for (const ent of entries) {
              if (ent.isIntersecting) {
                doLoad();
              }
            }
          },
          { root: null, rootMargin },
        );
        io.observe(el);
      } else {
        // immediate fallback
        doLoad();
      }

      //: HTMLElement, spec: BehaviorSpec) {
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

  return { register, get, action, setHypeInstance };
}

/* -------------------------------
 * Helpers used by behaviors
 * ------------------------------- */

function findScrollableAncestor(el: HTMLElement | null): Element | Window | null {
  if (!el) return window;
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;

    // Determine if the element is configured to scroll on either axis and actually has overflow
    const isOverflowY = overflowY === "auto" || overflowY === "scroll";
    const isOverflowX = overflowX === "auto" || overflowX === "scroll";

    // Require both a scrollable overflow style and content overflow (so we don't return containers
    // that are marked scrollable but have no overflow content).
    const canScrollY = isOverflowY && node.scrollHeight > node.clientHeight;
    const canScrollX = isOverflowX && node.scrollWidth > node.clientWidth;

    if (canScrollY || canScrollX) return node;
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
  // Module-scoped registry (WeakMap) that does not rely on globals or document availability.
  // WeakMap keys are ParentNode (e.g. Element or document.body) -> value is a Map of attrName => entry.
  type Entry = {
    handlers: Map<HTMLElement, () => void>;
    timers: Map<HTMLElement, number | null>;
    wired: WeakSet<HTMLElement>;
    observer: MutationObserver | null;
    hype?: any;
    refCount: number;
  };

  const registry = debounceRegistry;

  // Normalize Document -> body so callers using `document` vs `document.body` share the same registry entry.
  const normRoot: ParentNode = root instanceof Document ? (root.body as unknown as ParentNode) : root;

  let rootMap = registry.get(normRoot);
  if (!rootMap) {
    rootMap = new Map<string, Entry>();
    registry.set(normRoot, rootMap);
  }

  let entry: Entry | undefined = rootMap.get(attrName);
  if (!entry) {
    const handlers = new Map<HTMLElement, () => void>();
    const timers = new Map<HTMLElement, number | null>();
    const wired = new WeakSet<HTMLElement>();
    let observer: MutationObserver | null = null;

    function wire(el: HTMLElement) {
      // Avoid double wiring for the same element
      if (handlers.has(el) || wired.has(el)) return;
      const raw = el.getAttribute(attrName);
      if (!raw) return;
      const ms = Number(raw) || 300;
      let timer: number | null = null;

      // Insert placeholder to avoid races where wire is called concurrently
      handlers.set(el, () => {});
      wired.add(el);

      const onInput = (ev: Event) => {
        if (timer) {
          window.clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
          const ev2 = new CustomEvent("hype:debounced-input", {
            detail: { originalEvent: ev },
            bubbles: true,
            composed: true,
          });

          try {
            el.dispatchEvent(ev2);
          } catch {
            /* swallow DOM dispatch errors */
          }

          // Use the effective hype instance stored on the shared entry (if present),
          // otherwise fall back to the hype argument passed to this call.
          const effHype = (entry && entry.hype) || hype;
          if (effHype && typeof effHype.trigger === "function") {
            try {
              // ignore returned promise
              effHype.trigger(el).catch(() => {
                /* swallow */
              });
            } catch {
              /* swallow sync errors */
            }
          }

          timer = null;
        }, ms);
        timers.set(el, timer);
      };

      el.addEventListener("input", onInput);

      // replace placeholder with real unsubscribe
      handlers.set(el, () => {
        el.removeEventListener("input", onInput);
        const t = timers.get(el);
        if (t) window.clearTimeout(t);
        timers.delete(el);
        handlers.delete(el);
        try {
          wired.delete(el);
        } catch {
          /* ignore WeakSet delete errors in exotic environments */
        }
      });
    }

    // initial scan (use normalized root to avoid separate entries for document vs body)
    const scanRoot = normRoot as Element;
    const initial = Array.from((scanRoot as Element).querySelectorAll?.(`[${attrName}]`) || []);
    if (scanRoot instanceof Element && scanRoot.hasAttribute(attrName)) initial.unshift(scanRoot);
    for (const el of initial) wire(el as HTMLElement);

    // observe dynamic additions
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.hasAttribute && node.hasAttribute(attrName)) wire(node as HTMLElement);
          node.querySelectorAll?.(`[${attrName}]`)?.forEach((c: Element) => wire(c as HTMLElement));
        }
      }
    });

    try {
      if (typeof (scanRoot as Element).querySelectorAll === "function") {
        observer.observe(scanRoot as Element, { childList: true, subtree: true });
      } else {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } catch {
      /* ignore observation errors (non-browser environments) */
    }

    entry = { handlers, timers, wired, observer, hype: hype, refCount: 0 };
    rootMap.set(attrName, entry);
  }

  // Allow caller to update the stored hype instance for this registry entry.
  if (hype) {
    try {
      entry.hype = hype;
    } catch {
      /* ignore */
    }
  }

  // increase reference count for this caller
  entry.refCount++;

  const cleanup = () => {
    // decrement and cleanup when no callers remain
    entry!.refCount--;
    if (entry!.refCount <= 0) {
      try {
        entry!.observer?.disconnect();
      } catch {
        /* ignore */
      }
      entry!.handlers.forEach((unsub) => {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      });
      entry!.handlers.clear();
      entry!.timers.clear();

      // remove entry from rootMap and registry
      rootMap!.delete(attrName);
      if (rootMap!.size === 0) {
        registry.delete(normRoot);
      }
    }
  };

  return cleanup;
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

    // Inject the Hype instance into the registry so behaviors can prefer the instance API
    // (e.g. using `hype.templateClone`) rather than relying on globals like window.hype.
    try {
      if (typeof (registry as any).setHypeInstance === "function") {
        (registry as any).setHypeInstance(hypeInstance);
      }
    } catch {
      /* ignore injection errors */
    }

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
