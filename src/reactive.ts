/**
 * Reactive system for Hype
 *
 * This file implements a small reactive state system with:
 *  - data-hype-state parsing
 *  - data-hype-on-* event handlers
 *  - data-hype-show conditional visibility
 *  - data-hype-class-* conditional classes
 *  - data-hype-bind-* attribute binding
 *
 * It emphasizes defensive, non-throwing behavior
 */

import type { HypeConfig } from "./types";
import type { PubFn } from "./plugins/pubsub";
import { evalDsl, isDslString } from "./dsl/evalDsl";

/**
 * Context object containing reactive state for a component
 */
interface StateContext {
  state: Record<string, any>;
  element: HTMLElement;
  watchers: Set<() => void>;
  subs?: Set<() => void>;
}

/**
 * Reactive state system for Hype.
 */
export class ReactiveSystem {
  private debug: boolean;
  private contexts = new WeakMap<HTMLElement, StateContext>();
  private attributePrefix: string;
  private _pub?: PubFn;
  private handlers: Record<string, (current: any, ctx: { element: HTMLElement; event?: Event; statePath?: string; reactive: ReactiveSystem }) => any> = {};
  private pendingFlush = new WeakSet<HTMLElement>();
  // Guard to avoid re-entrant notifyWatchers causing infinite loops or stack growth.
  private _notifying = new WeakSet<HTMLElement>();
  // Queue guards used when reentrancyStrategy === 'defer' to schedule a later notify.
  private _queued = new WeakSet<HTMLElement>();
  // Depth tracking per-element to prevent extremely deep recursive notifications (DoS guard).
  private _depth = new WeakMap<HTMLElement, number>();
  // Config snapshot for this ReactiveSystem instance (frozen after construction).
  private _config: { attributePrefix: string; debug: boolean; reentrancyStrategy: "skip" | "defer"; maxNotifyDepth: number };
  // Convenience accessors derived from _config (set in constructor).
  private reentrancyStrategy!: "skip" | "defer";
  private maxNotifyDepth!: number;
  // Guard used when `setState()` explicitly forces a synchronous flush.
  // When a forced flush is in progress we avoid scheduling the proxy's
  // microtask-based notification to prevent duplicate deliveries.
  private _forcedFlush = new WeakSet<HTMLElement>();

  constructor(config: Partial<HypeConfig> = {}) {
    // Normalize and freeze a local config object — keep it immutable for the lifetime
    // of this ReactiveSystem instance to avoid dynamic mutation-based bugs.
    const local = {
      attributePrefix: config.attributePrefix ?? "hype",
      debug: config.debug ?? false,
      // Reentrancy strategy:
      //  - 'skip' (default): ignore nested notify calls for the same element (safe)
      //  - 'defer' : schedule another notify after the current notify completes
      reentrancyStrategy: (config as any)?.reentrancyStrategy ?? ("skip" as "skip" | "defer"),
      // Max allowed notify depth for a single element to protect against stack/DoS.
      maxNotifyDepth: (config as any)?.maxNotifyDepth ?? 20,
    };
    this._config = Object.freeze(local);
    this.attributePrefix = this._config.attributePrefix;
    this.debug = this._config.debug;
    this.reentrancyStrategy = this._config.reentrancyStrategy;
    this.maxNotifyDepth = this._config.maxNotifyDepth;
  }

  /**
   * Internal: synchronously flush pending microtask notifications for an element.
   * Kept small and defensive to avoid throwing during forced flushes.
   */
  private flushPendingNow(element: HTMLElement): void {
    try {
      if (this.pendingFlush.has(element)) {
        this.pendingFlush.delete(element);
        try {
          this.notifyWatchers(element);
        } catch {
          /* swallow watcher errors during a forced flush */
        }
      }
    } catch {
      /* swallow WeakSet errors */
    }
  }

  /**
   * Register a watcher callback for the given element's reactive context.
   *
   * - If the element has a reactive context the watcher will be registered and
   *   the returned function will unregister it.
   * - If the element has no reactive context this is a safe no-op and a
   *   callable no-op unsubscribe is returned (so callers don't need to guard).
   */
  public watch(element: HTMLElement, watcher: () => void): () => void {
    if (!element || typeof watcher !== "function") {
      return () => {
        /* no-op unsubscribe */
      };
    }

    try {
      const ctx = this.findContext(element);
      if (!ctx) {
        // no reactive context -> return safe no-op unsubscribe
        return () => {
          /* no-op */
        };
      }

      ctx.watchers.add(watcher);
      return () => {
        try {
          ctx.watchers.delete(watcher);
        } catch {
          /* ignore deletion errors */
        }
      };
    } catch {
      // Defensive: on any failure return a safe no-op unsubscribe
      return () => {
        /* no-op */
      };
    }
  }

  /**
   * Force immediate flush/notification for the given element.
   *
   * This is safe to call for elements without a reactive context or when no
   * notification is pending.
   */
  public flush(element: HTMLElement): void {
    try {
      this.flushPendingNow(element);
    } catch {
      /* swallow errors */
    }
  }

  /**
   * Register a named handler callable from markup.
   *
   * The handler can be referenced from markup by name. When a named handler is
   * invoked via an event directive (e.g. `data-hype-on-click="inc"`), the
   * runtime will pass the current value at the configured `data-hype-rx` /
   * `data-hype-var` state-path and a small context object.
   *
   * Returns an unregister function to remove the handler.
   *
   * Example usage:
   *   reactive.registerHandler('inc', (current) => (current || 0) + 1);
   *
   * @example
   * <!-- HTML example showing state + handler invocation -->
   * <div data-hype-state='{ "count": 0 }'>
   *   <button data-hype-on-click="inc" data-hype-rx="count">+</button>
   *   <span data-hype-bind-data-count="count">0</span>
   * </div>
   *
   * @param name - unique handler name
   * @param fn - function invoked with (currentValue, { element, event, statePath, reactive })
   * @returns a function that unregisters the handler when called
   */
  registerHandler(
    name: string,
    fn: (current: any, ctx: { element: HTMLElement; event?: Event; statePath?: string; reactive: ReactiveSystem }) => any,
  ): () => void {
    if (!name || typeof fn !== "function") throw new Error("registerHandler requires a name and a function");
    this.handlers[name] = fn;
    return () => {
      try {
        delete this.handlers[name];
      } catch {
        /* ignore */
      }
    };
  }

  /**
   * Attach pubsub helper (optional).
   */
  attachPubSub(pub?: PubFn): () => void {
    if (typeof pub === "function") this._pub = pub;
    return () => {
      this._pub = undefined;
    };
  }

  /**
   * Initialize reactive behavior on `root`.
   */
  init(root: HTMLElement): void {
    this.initStateComponents(root);
    this.processDirectives(root);
  }

  /**
   * Create reactive contexts for elements with data-hype-state
   */
  private initStateComponents(root: HTMLElement): void {
    const stateAttr = `data-${this.attributePrefix}-state`;
    const elems = root.hasAttribute(stateAttr) ? [root] : Array.from(root.querySelectorAll<HTMLElement>(`[${stateAttr}]`));
    elems.forEach((el) => {
      const stateStr = el.getAttribute(stateAttr);
      if (!stateStr) return;
      try {
        const initialState = this.parseState(stateStr);
        const context: StateContext = {
          state: this.createReactiveState(initialState, el),
          element: el,
          watchers: new Set(),
          subs: new Set(), // track event listener unsubscribe helpers to avoid leaks
        };
        this.contexts.set(el, context);
        this.log("Initialized state component", this.elementSummary(el), initialState);
      } catch (err) {
        // keep parsing errors visible but non-fatal
        // eslint-disable-next-line no-console
        console.error("Failed to parse state on element:", el, err);
      }
    });
  }

  /**
   * Process all directive types.
   */
  private processDirectives(root: HTMLElement): void {
    this.processEventDirectives(root);
    this.processShowDirectives(root);
    this.processClassDirectives(root);
    this.processBindDirectives(root);
  }

  /**
   * Event directives - data-hype-on-*
   */
  private processEventDirectives(root: HTMLElement): void {
    const pattern = new RegExp(`^data-${this.attributePrefix}-on-(.+)$`);
    this.walkTree(root, (el) => {
      const context = this.findContext(el);
      if (!context) return;
      Array.from(el.attributes).forEach((attr) => {
        const match = attr.name.match(pattern);
        if (!match) return;
        const eventName = match[1];
        if (!eventName) return;
        const expression = attr.value;
        // Create a named listener so we can remove it later and avoid leaks.
        const listener = async (event: Event) => {
          try {
            this.safeDebug("[reactive][event] evaluating expression:", expression, "event:", eventName, "element:", this.elementSummary(el));
            const result = this.evaluateExpression(expression, context, { $event: event, event, element: el });
            if (result && typeof (result as any).then === "function") {
              const awaited = await (result as any);
              this.safeDebug("[reactive][event] evaluation result (async):", awaited, "expression:", expression);
              try {
                this.flushPendingNow(context.element);
              } catch {
                /* ignore */
              }
              return awaited;
            }
            this.safeDebug("[reactive][event] evaluation result:", result, "expression:", expression);
            try {
              this.flushPendingNow(context.element);
            } catch {
              /* ignore */
            }
            return result;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[reactive][event] failed to evaluate expression:", expression, err);
          }
        };
        el.addEventListener(eventName, listener as EventListener);
        // Track unsubscribe helper on the component context to allow clean teardown.
        try {
          context.subs = context.subs || new Set();
          context.subs.add(() => {
            try {
              el.removeEventListener(eventName, listener as EventListener);
            } catch {
              /* ignore remove errors */
            }
          });
        } catch {
          /* ignore tracking errors */
        }
        this.log(`Attached ${eventName} handler to`, this.elementSummary(el));
      });
    });
  }

  /**
   * Show directives - data-hype-show
   */
  private processShowDirectives(root: HTMLElement): void {
    const showAttr = `data-${this.attributePrefix}-show`;
    this.walkTree(root, (el) => {
      if (!el.hasAttribute(showAttr)) return;
      const context = this.findContext(el);
      if (!context) return;
      const expression = el.getAttribute(showAttr)!;
      const originalDisplay = el.style.display || "";
      const update = () => {
        const shouldShow = this.evaluateExpression(expression, context);
        this.safeDebug("[reactive][show] expression:", expression, "->", shouldShow, "element:", this.elementSummary(el));
        if (shouldShow) {
          this.safeDebug("[reactive][show] setting display to originalDisplay:", originalDisplay, "previous display:", el.style.display);
          this.setDisplay(el, "");
          el.removeAttribute("hidden");
          this.safeDebug("[reactive][show] after set -> display:", el.style.display, "hidden:", el.hasAttribute("hidden"));
        } else {
          this.safeDebug("[reactive][show] setting display to 'none' previous display:", el.style.display);
          this.setDisplay(el, "none");
          el.setAttribute("hidden", "");
          this.safeDebug("[reactive][show] after set -> display:", el.style.display, "hidden:", el.hasAttribute("hidden"));
        }
      };
      context.watchers.add(update);
      update();
    });
  }

  /**
   * Class directives - data-hype-class-*
   */
  private processClassDirectives(root: HTMLElement): void {
    const pattern = new RegExp(`^data-${this.attributePrefix}-class-(.+)$`);
    this.walkTree(root, (el) => {
      const context = this.findContext(el);
      if (!context) return;
      Array.from(el.attributes).forEach((attr) => {
        const match = attr.name.match(pattern);
        if (!match) return;
        const className = match[1];
        if (!className) return;
        const expression = attr.value;
        const update = () => {
          const shouldAdd = this.evaluateExpression(expression, context);
          el.classList.toggle(className, !!shouldAdd);
        };
        context.watchers.add(update);
        update();
      });
    });
  }

  /**
   * Bind directives - data-hype-bind-*
   */
  private processBindDirectives(root: HTMLElement): void {
    const pattern = new RegExp(`^data-${this.attributePrefix}-bind-(.+)$`);
    this.walkTree(root, (el) => {
      const context = this.findContext(el);
      if (!context) return;
      Array.from(el.attributes).forEach((attr) => {
        const match = attr.name.match(pattern);
        if (!match) return;
        const attrName = match[1];
        if (!attrName) return;
        const expression = attr.value;
        const update = () => {
          const value = this.evaluateExpression(expression, context);
          if (value === false || value === null || value === undefined) {
            el.removeAttribute(attrName);
          } else if (value === true) {
            el.setAttribute(attrName, "");
          } else {
            el.setAttribute(attrName, String(value));
          }
          try {
            if (typeof attrName === "string" && attrName.startsWith("data-")) {
              el.textContent = value === undefined || value === null ? "" : String(value);
            }
          } catch {
            /* ignore */
          }
        };
        context.watchers.add(update);
        update();
      });
    });
  }

  /**
   * Parse state string (JSON-first, small single-quote normalization fallback)
   */
  private parseState(stateStr: string): Record<string, any> {
    try {
      return JSON.parse(stateStr);
    } catch (jsonErr) {
      try {
        const normalized = stateStr
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => {
            const escaped = inner.replace(/"/g, '\\"');
            return `"${escaped}"`;
          })
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_\\-]*)(\s*:)/g, (_m, pre, key, colon) => {
            return `${pre}"${key}"${colon}`;
          });
        return JSON.parse(normalized);
      } catch (fallbackErr) {
        throw new Error(`Failed to parse state as JSON. Original error: ${String(jsonErr)}; normalization error: ${String(fallbackErr)}. Use valid JSON for data-hype-state.`);
      }
    }
  }

  /**
   * Create proxied reactive state that schedules watcher notifications.
   */
  createReactiveState(initialState: Record<string, any>, element: HTMLElement): Record<string, any> {
  const self = this;
  return new Proxy(initialState, {
    set(target, prop, value) {
      const oldValue = target[prop as string];
      target[prop as string] = value;
      if (oldValue !== value) {
        self.log(`State changed: ${String(prop)} =`, value);
        try {
          // If we're currently notifying this element, respect the configured
          // reentrancy strategy instead of unconditionally scheduling another
          // microtask via pendingFlush. This avoids duplicate/double notifications
          // when watchers mutate state synchronously while a notify is in progress.
          if (self._notifying.has(element)) {
            if (self.reentrancyStrategy === "defer") {
              // Schedule a single deferred notify via the _queued guard.
              if (!self._queued.has(element)) {
                self._queued.add(element);
                Promise.resolve()
                  .then(() => {
                    try {
                      // Clear queued flag then call notifyWatchers.
                      try {
                        self._queued.delete(element);
                      } catch {
                        /* ignore delete errors */
                      }
                      self.notifyWatchers(element);
                    } catch (err) {
                      // eslint-disable-next-line no-console
                      console.error("[reactive] deferred notify error:", err);
                    }
                  })
                  .catch(() => {
                    /* swallow scheduling errors */
                  });
              }
            } else {
              // 'skip' strategy: do not schedule or call notify while current notify is active.
              // The mutation is applied to state, but watchers are not re-entered synchronously.
            }
          } else {
            // Normal scheduling path when not currently notifying.
            if (!self.pendingFlush.has(element) && !self._forcedFlush.has(element)) {
              self.pendingFlush.add(element);
              Promise.resolve()
                .then(() => {
                  try {
                    // If a forced flush already occurred for this element, avoid
                    // running notifyWatchers again from the scheduled microtask.
                    try {
                      if (self._forcedFlush && self._forcedFlush.has(element)) {
                        try {
                          self._forcedFlush.delete(element);
                        } catch {
                          /* ignore deletion errors */
                        }
                        return;
                      }
                    } catch {
                      /* ignore forcedFlush inspection errors */
                    }

                    try {
                      self.pendingFlush.delete(element);
                    } catch {
                      /* ignore delete errors */
                    }

                    self.notifyWatchers(element);
                  } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error("[reactive] notifyWatchers error:", err);
                  }
                })
                .catch(() => {
                  /* swallow scheduling errors */
                });
            } else {
              // If a forced flush was performed for this element, clear the flag
              // so the proxy does not schedule a redundant microtask notification.
              try {
                self._forcedFlush.delete(element);
              } catch {
                /* ignore deletion errors */
              }
            }
          }
        } catch {
          // Defensive: do not call notifyWatchers synchronously here. Swallow errors
          // to avoid duplicate notifications and preserve reentrancy semantics.
        }
      }
      return true;
    },
  });
}

  /**
   * Notify watchers: uses compact safe logging to avoid DOM/state dumps.
   */
  private notifyWatchers(element: HTMLElement): void {
    const context = this.contexts.get(element);
    if (!context) return;

    // If we're already notifying this element's watchers, honor the configured
    // reentrancy strategy:
    //  - 'skip' : do nothing (safe default)
    //  - 'defer': schedule a single deferred notify after the current notify finishes
    try {
      if (this._notifying.has(element)) {
        if (this.reentrancyStrategy === "defer") {
          // If already queued, do nothing; otherwise schedule a deferred notify.
          if (!this._queued.has(element)) {
          this._queued.add(element);
          Promise.resolve()
            .then(() => {
              try {
                // clear queued flag before calling notify to allow re-queues
                try {
                  this._queued.delete(element);
                } catch {
                  /* ignore */
                }

                // If a forced flush was performed for this element, skip the queued notify
                // because the forced flush already delivered notifications synchronously.
                try {
                  if (this._forcedFlush && this._forcedFlush.has(element)) {
                    try {
                      this._forcedFlush.delete(element);
                    } catch {
                      /* ignore deletion errors */
                    }
                    return;
                  }
                } catch {
                  /* ignore forcedFlush inspection errors */
                }

                this.notifyWatchers(element);
              } catch {
                /* swallow */
              }
            })
            .catch(() => {
              /* ignore scheduling errors */
            });
        }
        } else {
          // 'skip' behavior: do nothing and return early
          this.safeDebug("[reactive] notifyWatchers skipped due to re-entrancy for element:", this.elementSummary(element));
        }
        return;
      }
    } catch {
      /* ignore WeakSet errors */
    }

    // Depth guard: avoid repeated nested notifications for same element (DoS protection).
    try {
      const prevDepth = this._depth.get(element) || 0;
      if (prevDepth >= this.maxNotifyDepth) {
        this.safeDebug("[reactive] notifyWatchers depth limit reached; skipping for element:", this.elementSummary(element), "depth:", prevDepth);
        return;
      }
      this._depth.set(element, prevDepth + 1);
    } catch {
      /* ignore depth WeakMap errors */
    }

    try {
      // mark notifying for this element
      try {
        this._notifying.add(element);
      } catch {
        /* ignore */
      }

      // Build a compact snapshot suitable for logs
      const safeState = this.safeStateSnapshot(context.state);
      const elSummary = this.elementSummary(context.element);

      this.safeDebug("[reactive] notifyWatchers - element:", elSummary, "watcherCount:", context.watchers.size, "stateSnapshot:", safeState);

      // Invoke watchers (defensive)
      context.watchers.forEach((watcher) => {
        try {
          this.safeDebug("[reactive] invoking watcher for element:", elSummary);
          watcher();
          this.safeDebug("[reactive] watcher completed for element:", elSummary);
        } catch (error) {
          try {
            this.safeDebug("[reactive] Error in watcher for element:", elSummary, "state:", safeState, error);
          } catch {
            try {
              // final fallback to console.error
              // eslint-disable-next-line no-console
              console.error("[reactive] Error in watcher (failed to serialize context)", error);
            } catch {
              /* ignore */
            }
          }
        }
      });
    } finally {
      // clear notifying flag and decrement depth
      try {
        this._notifying.delete(element);
      } catch {
        /* ignore WeakSet errors */
      }
      try {
        const d = this._depth.get(element) || 0;
        if (d > 0) {
          this._depth.set(element, d - 1);
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Evaluate expression in context: DSL-first, simple translator for binary/unary, named handlers, fallback to getPath.
   */
  private evaluateExpression(expression: string, context: StateContext, extra: Record<string, any> = {}): any {
    try {
      const trimmed = typeof expression === "string" ? expression.trim() : expression;
      const invokingElement: HTMLElement = (extra && (extra as any).element) || context.element;
      const extras = {
        $el: invokingElement,
        el: invokingElement,
        $event: extra.$event || (extra as any).event,
        event: extra.$event || (extra as any).event,
        $fetch: (url?: any, init?: any) => {
          try {
            if (typeof (extra as any).$fetch === "function") return (extra as any).$fetch(url, init);
            // Avoid synthetic dispatch of DOM events as a fallback. Synthetic dispatch
            // can cause confusing reentrancy and stack growth in reactive loops.
            // If consumers need fetch behavior inject a real $fetch in the extra context.
            return undefined;
          } catch {
            /* ignore */
          }
        },
      };

      if (typeof trimmed === "string") {
        const binaryMatch = trimmed.match(/^\s*([A-Za-z_$][0-9A-Za-z_$.]*)\s*(===|==|!=|>=|<=|>|<)\s*(.+)\s*$/);
        if (binaryMatch) {
          const lhs = binaryMatch[1];
          const op = binaryMatch[2];
          let rhsRaw = (binaryMatch[3] || "").trim();
          let rhs: any;
          if (/^\d+(\.\d+)?$/.test(rhsRaw)) {
            rhs = Number(rhsRaw);
          } else if (/^(true|false)$/.test(rhsRaw)) {
            rhs = rhsRaw === "true";
          } else if (/^'.*'$/.test(rhsRaw) || /^".*"$/.test(rhsRaw)) {
            rhs = rhsRaw.slice(1, -1);
          } else {
            rhs = ["get", rhsRaw];
          }
          try {
            return evalDsl([op, ["get", lhs], rhs], {
              state: context.state,
              pub: this._pub ? (t: string, p?: any) => (this._pub as PubFn)(t, p) : undefined,
              extras,
            });
          } catch {
            /* fall through */
          }
        }
        const unaryMatch = trimmed.match(/^\!\s*([A-Za-z_$][0-9A-Za-z_$.]*)\s*$/);
        if (unaryMatch) {
          try {
            return evalDsl(["!", ["get", unaryMatch[1]]], {
              state: context.state,
              pub: this._pub ? (t: string, p?: any) => (this._pub as PubFn)(t, p) : undefined,
              extras,
            });
          } catch {
            /* fall through */
          }
        }
      }

      if (isDslString(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed as string);
          return evalDsl(parsed, { state: context.state, pub: this._pub ? (t: string, p?: any) => (this._pub as PubFn)(t, p) : undefined, extras });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[reactive] invalid DSL JSON expression:", expression, err);
          return false;
        }
      }

      if (typeof trimmed === "string" && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(trimmed)) {
        const handler = this.handlers[trimmed];
        if (typeof handler === "function") {
          const invokingEl: HTMLElement = (extra && (extra as any).element) || context.element;
          const statePath = invokingEl.getAttribute(`data-${this.attributePrefix}-rx`) || invokingEl.getAttribute(`data-${this.attributePrefix}-var`) || undefined;
          const current = statePath ? this.getPath(context.state, statePath) : undefined;
          try {
            const handlerCtx = {
              element: invokingEl,
              event: extra.$event || (extra as any).event,
              statePath,
              reactive: this,
            };
            const maybe = handler(current, handlerCtx);
            if (maybe && typeof (maybe as any).then === "function") {
              return (maybe as Promise<any>).then((res) => {
                if (statePath && res !== undefined) this.setPath(context.state, statePath, res);
                return res;
              });
            } else {
              if (statePath && maybe !== undefined) this.setPath(context.state, statePath, maybe);
              return maybe;
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[reactive] handler error for", trimmed, err);
            return false;
          }
        }
      }

      if (typeof trimmed === "string") {
        return this.getPath(context.state, trimmed);
      }
      return false;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to evaluate expression: ${expression}`, error);
      return false;
    }
  }

  private getPath(obj: any, path: string | string[]): any {
    if (path == null) return undefined;
    const parts: string[] = Array.isArray(path) ? (path as string[]) : String(path).split(".");
    let cur: any = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p as string];
    }
    return cur;
  }

  private setPath(obj: any, path: string | string[], value: any): void {
    const parts: string[] = Array.isArray(path) ? (path as string[]) : String(path).split(".");
    let cur: any = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p as string] == null || typeof cur[p as string] !== "object") cur[p as string] = {};
      cur = cur[p as string];
    }
    const last = parts[parts.length - 1];
    if (last !== undefined) {
      cur[last as string] = value;
    }
  }

  private findContext(element: HTMLElement): StateContext | null {
    let current: HTMLElement | null = element;
    while (current) {
      const context = this.contexts.get(current);
      if (context) return context;
      current = current.parentElement;
    }
    return null;
  }

  private walkTree(root: HTMLElement, callback: (el: HTMLElement) => void): void {
    callback(root);
    Array.from(root.children).forEach((child) => {
      if (child instanceof HTMLElement) this.walkTree(child, callback);
    });
  }

  /**
   * Defensive safe debug helper. Avoids throw when logging complex DOM objects.
   *
   * This helper:
   *  - respects the ReactiveSystem debug flag (no-op when disabled)
   *  - replaces HTMLElement values with a compact `elementSummary`
   *  - converts Errors to { name, message } to avoid huge stacks in logs
   *  - shallow-clones objects while sanitizing nested `element` fields
   *
   * Example (what you might see in your console when debug=true):
   *   [Hype Reactive] [reactive][show] expression: "visible" -> true element: { tag: 'div', id: 'app', classes: ['foo'], dataset: { tab: '1' } }
   */
  private safeDebug(...args: any[]): void {
    if (!this.debug) return;

    // Sanitize arguments to avoid expensive DOM serialization or leaking huge state.
    // We attempt to replace any HTMLElement values (or objects containing an `element`
    // field that is an HTMLElement) with a compact summary produced by `elementSummary`.
    try {
      const safeArgs = args.map((a) => {
        try {
          if (a instanceof HTMLElement) {
            return this.elementSummary(a);
          }

          // If it's an Error preserve useful fields but avoid full stack if huge.
          if (a instanceof Error) {
            return { name: a.name, message: a.message };
          }

          if (a && typeof a === "object") {
            // Shallow clone while sanitizing any nested element fields.
            const out: any = Array.isArray(a) ? [] : {};
            for (const k of Object.keys(a)) {
              try {
                const v = (a as any)[k];
                if (v instanceof HTMLElement) {
                  out[k] = this.elementSummary(v);
                } else {
                  // keep primitives and small objects as-is
                  out[k] = v;
                }
              } catch {
                out[k] = "[unserializable]";
              }
            }
            return out;
          }

          // Primitive (string/number/boolean/undefined/null)
          return a;
        } catch {
          return "[unserializable]";
        }
      });

      // eslint-disable-next-line no-console
      console.debug("[Hype Reactive]", ...safeArgs);
    } catch {
      // swallow logging errors to avoid breaking app logic
    }
  }

  /**
   * Compact summary of an element for logs.
   */
  private elementSummary(el: any): any {
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

  /**
   * Create a shallow safe representation of state for logs.
   */
  private safeStateSnapshot(state: Record<string, any>): Record<string, any> | string {
    try {
      if (!state || typeof state !== "object") return state;
      const keys = Object.keys(state);
      if (keys.length > 30) return `state with ${keys.length} keys`;
      const snap: Record<string, any> = {};
      for (const k of keys) {
        const v = state[k];
        if (v && (v instanceof HTMLElement || (v as any).tagName)) {
          snap[k] = this.elementSummary(v);
        } else if (typeof v === "object") {
          if (Array.isArray(v)) snap[k] = `[array:${v.length}]`;
          else snap[k] = `object`;
        } else {
          snap[k] = v;
        }
      }
      return snap;
    } catch {
      return "[unserializable state]";
    }
  }

  /**
   * Set inline display with CSSOM first, then fallback.
   */
  private setDisplay(el: HTMLElement, value: string): void {
    try {
      el.style.setProperty("display", value);
      return;
    } catch {
      /* fallback */
    }
    try {
      // eslint-disable-next-line no-param-reassign
      el.style.display = value;
    } catch {
      /* ignore */
    }
  }

  private log(...args: any[]): void {
    this.safeDebug(...args);
  }

  /**
   * Public helpers
   */
  getState(element: HTMLElement): Record<string, any> | null {
    const ctx = this.findContext(element);
    return ctx ? ctx.state : null;
  }

  getConfig(): { attributePrefix: string; debug: boolean; reentrancyStrategy: "skip" | "defer"; maxNotifyDepth: number } {
    return {
      attributePrefix: this.attributePrefix,
      debug: this.debug,
      reentrancyStrategy: this.reentrancyStrategy,
      maxNotifyDepth: this.maxNotifyDepth,
    };
  }

  setState(element: HTMLElement, updates: Record<string, any>): void {
    const context = this.findContext(element);
    if (!context) return;

    // Apply updates to the proxied state immediately so callers see updated values.
    Object.assign(context.state, updates);

    // If watchers are currently being invoked for this element, honor the configured
    // reentrancy strategy rather than forcing another immediate notification.
    // - 'defer': schedule a single deferred notify after the current notify completes
    // - 'skip' : do not schedule a notify now (the state is updated, watchers will not re-enter)
    try {
      const currentlyNotifying = (() => {
        try {
          return this._notifying.has(element);
        } catch {
          return false;
        }
      })();

      if (currentlyNotifying) {
        if (this.reentrancyStrategy === "defer") {
          try {
            if (!this._queued.has(element)) {
              this._queued.add(element);
              Promise.resolve()
                .then(() => {
                  try {
                    try {
                      this._queued.delete(element);
                    } catch {
                      /* ignore delete errors */
                    }
                    // If a forced flush happened meanwhile, respect it (flush path clears _forcedFlush).
                    try {
                      if (this._forcedFlush && this._forcedFlush.has(element)) {
                        try {
                          this._forcedFlush.delete(element);
                        } catch {
                          /* ignore deletion errors */
                        }
                        return;
                      }
                    } catch {
                      /* ignore forcedFlush checks */
                    }
                    this.notifyWatchers(element);
                  } catch {
                    /* swallow notify errors */
                  }
                })
                .catch(() => {
                  /* swallow scheduling errors */
                });
            }
          } catch {
            /* ignore queue errors */
          }
        }
        // 'skip' : do nothing here (mutation applied, but notification is not re-entered)
        return;
      }
    } catch {
      // ignore reentrancy checks and fall through to perform a normal flush
    }

    // Not currently notifying: perform immediate flush so callers using setState
    // observe synchronous behavior. flushPendingNow will mark _forcedFlush so the
    // proxy microtask (if scheduled) will not duplicate the notification.
    try {
      this.flushPendingNow(context.element);
    } catch {
      /* ignore flush errors */
    }
  }

  destroy(element: HTMLElement): void {
    const context = this.contexts.get(element);
    if (!context) return;
    try {
      // If the context tracked subscription cleanup helpers (for event listeners),
      // call them to remove attached handlers and avoid leaks.
      try {
        if (context.subs && context.subs.size) {
          for (const unsub of Array.from(context.subs)) {
            try {
              unsub();
            } catch {
              /* ignore individual unsubscribe errors */
            }
          }
          try {
            context.subs.clear();
          } catch {
            /* ignore clear errors */
          }
        }
      } catch {
        /* ignore subs iteration errors */
      }

      // Clear watcher set
      context.watchers.clear();
    } catch {
      /* ignore */
    }

    // Clean scheduling / reentrancy guards for this element if present
    try {
      this.pendingFlush.delete(element);
    } catch {
      /* ignore */
    }
    try {
      // _notifying is a WeakSet guard to prevent re-entrant notify loops; ensure it's cleared.
      if ((this as any)._notifying && typeof (this as any)._notifying.delete === "function") {
        try {
          (this as any)._notifying.delete(element);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }

    this.contexts.delete(element);
  }
}

/**
 * Factory
 */
export function createReactive(config?: Partial<HypeConfig>): ReactiveSystem {
  return new ReactiveSystem(config);
}
