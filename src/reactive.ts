import type { HypeConfig } from "./types";
import type { PubFn } from "./plugins/pubsub";
import { evalDsl, isDslString } from "./dsl/evalDsl";

/**
 * Context object containing reactive state for a component
 * @interface StateContext
 */
interface StateContext {
  /** The reactive state object */
  state: Record<string, any>;
  /** The DOM element this context is attached to */
  element: HTMLElement;
  /** Set of watcher functions that run when state changes */
  watchers: Set<() => void>;
  /** Optional set of unsubscribe functions for subscriptions attached to this context */
  subs?: Set<() => void>;
}

/**
 * Reactive state system for Hype
 *
 * Provides Alpine.js-inspired directives for component state and reactivity.
 * Supports:
 * - `data-hype-state` - Declare reactive state
 * - `data-hype-on-{event}` - Event handlers with state access
 * - `data-hype-show` - Conditional visibility
 * - `data-hype-class-{className}` - Conditional classes
 * - `data-hype-bind-{attribute}` - Attribute binding
 *
 * @example
 * ```html
 * <div data-hype-state='{ "count": 0 }'>
 *   <button data-hype-on-click="set('count', count + 1)">+</button>
 *   <span data-hype-bind-data-count="count">0</span>
 * </div>
 * ```
 *
 * @class ReactiveSystem
 */
export class ReactiveSystem {
  /** Debug mode flag */
  private debug: boolean;

  /** WeakMap storing state contexts for each reactive element */
  private contexts = new WeakMap<HTMLElement, StateContext>();

  /** Attribute prefix for directives (default: "hype") */
  private attributePrefix: string;

  /** Optional injected pub/sub functions (attached via attachPubSub) */
  private _pub?: PubFn;

  /** Handler registry: named, trusted callbacks authors register explicitly */
  private handlers: Record<string, (current: any, ctx: { element: HTMLElement; event?: Event; statePath?: string; reactive: ReactiveSystem }) => any> = {};
  /** Pending microtask flush set to coalesce watcher notifications per element */
  private pendingFlush = new WeakSet<HTMLElement>();

  /**
   * Flush any pending microtask-scheduled notifications for the given element
   * synchronously. This is used to ensure that state changes performed within
   * event handlers are reflected in the DOM before the handler returns.
   *
   * We keep this intentionally small and defensive: it deletes the pending
   * marker and invokes notifyWatchers directly. Any exceptions are swallowed
   * to avoid breaking application code during cleanup.
   */
  private flushPendingNow(element: HTMLElement): void {
    try {
      if (this.pendingFlush.has(element)) {
        this.pendingFlush.delete(element);
        try {
          this.notifyWatchers(element);
        } catch {
          // swallow watcher errors during a forced flush
        }
      }
    } catch {
      // swallow WeakSet errors or other unexpected failures
    }
  }

  /**
   * Public helper: flush pending notifications for an element synchronously.
   *
   * Safe wrapper for external callers (tests/integrations) to force watcher execution.
   * Keeps behavior defensive: errors are swallowed to avoid breaking callers.
   */
  public flush(element: HTMLElement): void {
    try {
      this.flushPendingNow(element);
    } catch {
      // swallow errors to keep external calls safe
    }
  }

  /**
   * Public helper: register a watcher for the nearest reactive context of an element.
   *
   * Returns an unsubscribe function that removes the watcher. This is a safe,
   * explicit API surface so integrators don't need to reach into internals.
   *
   * If no context exists for the provided element, the method attempts a best-effort
   * initialization (calling `init` on the element) and then registers the watcher
   * if a context becomes available.
   */
  public watch(element: HTMLElement, watcher: () => void): () => void {
    if (!element || typeof watcher !== "function") {
      return () => {};
    }

    // Find existing context
    let context = this.findContext(element);
    if (!context) {
      // Try to initialize reactive subsystem on this element in case it defines state.
      try {
        this.init(element);
      } catch {
        /* ignore init failures */
      }
      context = this.findContext(element);
      if (!context) {
        return () => {};
      }
    }

    try {
      context.watchers.add(watcher);
    } catch {
      // defensive: if adding fails, provide a no-op unsubscribe
      return () => {};
    }

    // Return unsubscribe
    return () => {
      try {
        context!.watchers.delete(watcher);
      } catch {
        /* ignore */
      }
    };
  }

  /**
   * Create a new ReactiveSystem instance
   *
   * @param {Partial<HypeConfig>} config - Configuration options
   * @param {boolean} config.debug - Enable debug logging
   * @param {string} config.attributePrefix - Custom attribute prefix (default: "hype")
   */
  constructor(config: Partial<HypeConfig> = {}) {
    this.debug = config.debug ?? false;
    this.attributePrefix = config.attributePrefix ?? "hype";
  }

  /**
   * Register a named handler that can be referenced from markup.
   *
   * Example:
   *   reactive.registerHandler('inc', (current) => (current||0) + 1);
   *
   * Returns an unregister function to remove the handler.
   */
  registerHandler(
    name: string,
    fn: (current: any, ctx: { element: HTMLElement; event?: Event; statePath?: string; reactive: ReactiveSystem }) => any,
  ): () => void {
    if (!name || typeof fn !== "function") {
      throw new Error("registerHandler requires a name and a function");
    }
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
   * Attach external pub/sub functions to the reactive system.
   *
   * This is useful for tests or when a pub/sub implementation is provided
   * externally (e.g. via a plugin). Returns a cleanup function which removes
   * the attached references.
   */
  attachPubSub(pub?: PubFn): () => void {
    if (typeof pub === "function") this._pub = pub;
    return () => {
      this._pub = undefined;
    };
  }

  /**
   * Initialize reactive behavior on an element and its descendants
   *
   * Scans for state declarations and processes all reactive directives.
   * Safe to call multiple times - will only initialize once per element.
   *
   * @param {HTMLElement} root - The root element to initialize
   *
   * @example
   * ```typescript
   * const reactive = new ReactiveSystem();
   * reactive.init(document.body);
   * ```
   */
  init(root: HTMLElement): void {
    this.initStateComponents(root);
    this.processDirectives(root);
  }

  /**
   * Find and initialize all elements with state declarations
   *
   * Searches for `data-hype-state` attributes and creates reactive
   * state contexts for each element.
   *
   * @private
   * @param {HTMLElement} root - The root element to search from
   */
  private initStateComponents(root: HTMLElement): void {
    const stateAttr = `data-${this.attributePrefix}-state`;
    const elements = root.hasAttribute(stateAttr) ? [root] : Array.from(root.querySelectorAll<HTMLElement>(`[${stateAttr}]`));

    elements.forEach((el) => {
      const stateStr = el.getAttribute(stateAttr);
      if (!stateStr) return;

      try {
        // Parse initial state
        const initialState = this.parseState(stateStr);
        const context: StateContext = {
          state: this.createReactiveState(initialState, el),
          element: el,
          watchers: new Set(),
        };

        this.contexts.set(el, context);
        this.log("Initialized state component", el, initialState);
      } catch (error) {
        console.error(`Failed to parse state on element:`, el, error);
      }
    });
  }

  /**
   * Process all reactive directives on an element tree
   *
   * @private
   * @param {HTMLElement} root - The root element to process
   */
  private processDirectives(root: HTMLElement): void {
    this.processEventDirectives(root);
    this.processShowDirectives(root);
    this.processClassDirectives(root);
    this.processBindDirectives(root);
  }

  /**
   * Process event handler directives (data-hype-on-{event})
   *
   * Attaches event listeners that can access and modify reactive state.
   * Event handler attribute values may be either:
   *  - A DSL JSON expression string (e.g. '["set","count",["+",["get","count"],1]]')
   *  - A single identifier naming a registered handler (e.g. "incCount")
   *
   * Named handlers are registered with `registerHandler` and are trusted code.
   *
   * @private
   * @param {HTMLElement} root - The root element to process
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

        // async listener to support handler promises
        el.addEventListener(eventName, async (event) => {
          try {
            if (this.debug) {
              // eslint-disable-next-line no-console
              console.debug("[reactive][event] evaluating expression:", expression, "event:", eventName, "element:", el);
            }

            // Pass both the raw Event and the invoking element into evaluateExpression so
            // the evaluator and named handlers can access the attribute element and event.
            const result = this.evaluateExpression(expression, context, { $event: event, event, element: el });

            // If the expression returned a promise, await it then flush watchers
            if (result && typeof (result as any).then === "function") {
              const awaited = await (result as any);
              if (this.debug) {
                // eslint-disable-next-line no-console
                console.debug("[reactive][event] evaluation result (async):", awaited, "expression:", expression);
              }
              // Ensure watchers reflect any state changes caused by the async handler.
              // Use flushPendingNow to synchronously flush any pending microtask notifications
              // so DOM updates are visible immediately after async handler resolution.
              try {
                this.flushPendingNow(context.element);
              } catch {
                /* ignore notify failures in event handlers */
              }
              return awaited;
            }

            if (this.debug) {
              // eslint-disable-next-line no-console
              console.debug("[reactive][event] evaluation result:", result, "expression:", expression);
            }

            // Synchronously flush watchers so DOM updates (e.g. data-hype-show) are visible
            // immediately after the event handler returns.
            try {
              this.flushPendingNow(context.element);
            } catch {
              /* ignore notify failures in event handlers */
            }

            return result;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[reactive][event] failed to evaluate expression:", expression, err);
          }
        });

        this.log(`Attached ${eventName} handler to`, el);
      });
    });
  }

  /**
   * Process conditional visibility directives (data-hype-show)
   *
   * Shows or hides elements based on state expressions.
   * Uses both `display: none` and `hidden` attribute for maximum compatibility.
   *
   * @private
   * @param {HTMLElement} root - The root element to process
   *
   * @example
   * ```html
   * <div data-hype-show="isVisible">Content</div>
   * <div data-hype-show="count > 0">Has items</div>
   * <div data-hype-show="!loading">Ready</div>
   * ```
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

        // Debug: surface expression evaluation result and relevant context when debug mode is enabled.
        if (this.debug) {
          try {
            // eslint-disable-next-line no-console
            console.debug("[reactive][show] expression:", expression, "->", shouldShow, "element:", el, "stateSnapshot:", { ...context.state });
          } catch {
            // ignore logging errors
          }
        }

        if (shouldShow) {
          // Log previous display value and the intended assignment for easier tracing
          if (this.debug) {
            try {
              // eslint-disable-next-line no-console
              console.debug("[reactive][show] setting display to originalDisplay:", originalDisplay, "previous display:", el.style.display);
            } catch {
              /* ignore logging errors */
            }
          }

          // Set inline display to empty string so style.display === '' (visible)
          try {
            el.style.setProperty("display", "");
          } catch {
            // fallback to direct assignment if setProperty not supported
            try {
              // eslint-disable-next-line no-param-reassign
              el.style.display = "";
            } catch {
              /* ignore */
            }
          }

          el.removeAttribute("hidden");

          // Confirm assignment
          if (this.debug) {
            try {
              // eslint-disable-next-line no-console
              console.debug("[reactive][show] after set -> display:", el.style.display, "hidden:", el.hasAttribute("hidden"));
            } catch {
              /* ignore logging errors */
            }
          }
        } else {
          // Log previous display value and the intended assignment for easier tracing
          if (this.debug) {
            try {
              // eslint-disable-next-line no-console
              console.debug("[reactive][show] setting display to 'none' previous display:", el.style.display);
            } catch {
              /* ignore logging errors */
            }
          }

          // Use CSSOM setProperty to set explicit 'none'
          try {
            el.style.setProperty("display", "none");
          } catch {
            // fallback to direct assignment
            try {
              // eslint-disable-next-line no-param-reassign
              el.style.display = "none";
            } catch {
              /* ignore */
            }
          }

          el.setAttribute("hidden", "");

          // Confirm assignment
          if (this.debug) {
            try {
              // eslint-disable-next-line no-console
              console.debug("[reactive][show] after set -> display:", el.style.display, "hidden:", el.hasAttribute("hidden"));
            } catch {
              /* ignore logging errors */
            }
          }
        }
      };

      context.watchers.add(update);
      update(); // Initial evaluation (synchronous)
    });
  }

  /**
   * Process conditional class directives (data-hype-class-{className})
   *
   * Adds or removes CSS classes based on state expressions.
   * Supports multiple classes and complex expressions.
   *
   * @private
   * @param {HTMLElement} root - The root element to process
   *
   * @example
   * ```html
   * <div data-hype-class-active="isActive">Content</div>
   * <div data-hype-class-text-red-500="hasError">Error text</div>
   * <button data-hype-class-font-bold="selected">Item</button>
   * ```
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
        update(); // Initial evaluation
      });
    });
  }

  /**
   * Process attribute binding directives (data-hype-bind-{attribute})
   *
   * Binds element attributes to state values.
   * Handles boolean attributes (disabled, checked) and value attributes.
   *
   * @private
   * @param {HTMLElement} root - The root element to process
   *
   * @example
   * ```html
   * <button data-hype-bind-disabled="loading">Submit</button>
   * <input data-hype-bind-value="inputValue">
   * <img data-hype-bind-src="imageUrl">
   * <div data-hype-bind-data-count="count">0</div>
   * ```
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
          // Convenience: mirror common data-* attribute bindings into visible textContent
          // so simple UI elements (counters, labels) render without extra page JS.
          try {
            if (typeof attrName === "string" && attrName.startsWith("data-")) {
              el.textContent = value === undefined || value === null ? "" : String(value);
            }
          } catch {
            /* ignore mirror failures */
          }
        };

        context.watchers.add(update);
        update(); // Initial evaluation
      });
    });
  }

  /**
   * Parse state string into an object
   *
   * Supports both JSON notation and JavaScript object literal notation.
   *
   * @private
   * @param {string} stateStr - The state string to parse
   * @returns {Record<string, any>} The parsed state object
   * @throws {Error} If the state string cannot be parsed
   *
   * @example
   * ```typescript
   * parseState('{ "count": 0 }')  // JSON
   * parseState('{ count: 0 }')    // JS object literal
   * ```
   */
  private parseState(stateStr: string): Record<string, any> {
    // Prefer strict JSON parsing for safety. We intentionally avoid `new Function`
    // and other dynamic evaluation mechanisms. If JSON.parse fails we attempt a
    // conservative single-quote -> double-quote normalization as a best-effort
    // fallback for common authoring errors (e.g. using single quotes).
    //
    // NOTE: This keeps the parser KISS and secure: unsupported not-quite-JSON
    // inputs will throw and surface a parse error rather than executing code.
    try {
      return JSON.parse(stateStr);
    } catch (jsonErr) {
      // Try a conservative normalization: replace single-quoted string boundaries
      // with double quotes. This is intentionally limited and will not rescue all
      // invalid JS object literal forms. We avoid evaluating arbitrary JS.
      try {
        const normalized = stateStr
          // replace single-quoted string values '...' with "..."; avoid touching already double-quoted segments
          .replace(/'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'/g, (_, inner) => {
            // Escape any existing double-quotes in the captured inner content
            const escaped = inner.replace(/"/g, '\\"');
            return `"${escaped}"`;
          })
          // small normalization: convert bare keys like { key: 1 } -> { "key": 1 }
          // only when safe-ish: match unquoted keys at object starts or after commas
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_\\-]*)(\\s*:)/g, (_m, pre, key, colon) => {
            return `${pre}"${key}"${colon}`;
          });

        return JSON.parse(normalized);
      } catch (fallbackErr) {
        throw new Error(
          `Failed to parse state as JSON. Original error: ${String(jsonErr)}; normalization error: ${String(fallbackErr)}. Use valid JSON for data-hype-state.`,
        );
      }
    }
  }

  /**
   * Create a reactive state object using Proxy
   *
   * Wraps the state in a Proxy that intercepts property changes
   * and triggers watchers when values are modified.
   *
   * @private
   * @param {Record<string, any>} initialState - The initial state object
   * @param {HTMLElement} element - The element this state belongs to
   * @returns {Record<string, any>} A proxied reactive state object
   */
  private createReactiveState(initialState: Record<string, any>, element: HTMLElement): Record<string, any> {
    const self = this;

    return new Proxy(initialState, {
      set(target, prop, value) {
        const oldValue = target[prop as string];
        target[prop as string] = value;

        if (oldValue !== value) {
          self.log(`State changed: ${String(prop)} =`, value);

          // Coalesce notifications per element and schedule on microtask queue.
          // This ensures that watchers run after event handlers complete and
          // multiple synchronous state changes are observed once.
          try {
            if (!self.pendingFlush.has(element)) {
              self.pendingFlush.add(element);
              Promise.resolve()
                .then(() => {
                  try {
                    self.pendingFlush.delete(element);
                    self.notifyWatchers(element);
                  } catch (err) {
                    // ensure exceptions don't bubble unpredictably
                    // eslint-disable-next-line no-console
                    console.error("[reactive] notifyWatchers error:", err);
                  }
                })
                .catch(() => {
                  // swallow scheduling errors
                });
            }
          } catch {
            // If WeakSet or Promise aren't available, fallback to synchronous notify
            try {
              self.notifyWatchers(element);
            } catch {
              /* ignore */
            }
          }
        }

        return true;
      },
    });
  }

  /**
   * Notify all watchers that state has changed
   *
   * Executes all registered watcher functions for the given element's context.
   *
   * @private
   * @param {HTMLElement} element - The element whose watchers to notify
   */
  private notifyWatchers(element: HTMLElement): void {
    const context = this.contexts.get(element);
    if (!context) return;

    // Always log watcher invocation for debugging purposes
    try {
      // eslint-disable-next-line no-console
      console.debug("[reactive] notifyWatchers - element:", element, "watcherCount:", context.watchers.size, "stateSnapshot:", { ...context.state });
    } catch {
      try {
        // eslint-disable-next-line no-console
        console.debug("[reactive] notifyWatchers - element:", element, "watcherCount:", context.watchers.size);
      } catch {
        /* ignore logging failures */
      }
    }

    context.watchers.forEach((watcher) => {
      try {
        // Log before invoking each watcher
        // eslint-disable-next-line no-console
        console.debug("[reactive] invoking watcher for element:", element);
        watcher();
        // Log after watcher completes
        // eslint-disable-next-line no-console
        console.debug("[reactive] watcher completed for element:", element);
      } catch (error) {
        // Provide richer context when a watcher throws to make debugging easier
        try {
          // eslint-disable-next-line no-console
          console.error("[reactive] Error in watcher for element:", element, "state:", context.state, error);
        } catch {
          // fallback minimal error log
          // eslint-disable-next-line no-console
          console.error("[reactive] Error in watcher (failed to serialize context)", error);
        }
      }
    });
  }

  /**
   * Evaluate an expression in the context of reactive state
   *
   * Behavior:
   *  - If `expression` looks like DSL JSON (starts with `[` or `{`), it is
   *    parsed via `JSON.parse` and evaluated using the small DSL interpreter
   *    (`evalDsl`) — no `new Function` or eval is used.
   *  - If `expression` is a single identifier and a handler with that name is
   *    registered via `registerHandler`, the handler is invoked. If the element
   *    has `data-{prefix}-rx="path"` the current value at `path` is passed to
   *    the handler and any returned value (sync or Promise) is written back to
   *    that path (via `setPath`) so watchers run.
   *  - Otherwise, we attempt a safe read of the state path (simple dotted path or identifier).
   *
   * This function intentionally avoids evaluating arbitrary JS strings.
   */
  private evaluateExpression(expression: string, context: StateContext, extra: Record<string, any> = {}): any {
    try {
      const trimmed = typeof expression === "string" ? expression.trim() : expression;

      // Prefer the actual invoking element (the element that carried the attribute) when
      // exposing extras to DSL and handlers. Fall back to the component root element.
      const invokingElement: HTMLElement = (extra && (extra as any).element) || context.element;

      const extras = {
        // expose both `$el` (DSL-friendly) and `el` (DOM-friendly) references
        $el: invokingElement,
        el: invokingElement,
        // expose both `$event` and `event` so callers/DSL/handlers can use either
        $event: extra.$event || (extra as any).event,
        event: extra.$event || (extra as any).event,
        // $fetch may be provided by the caller in extras; if not, provide a fallback
        $fetch: (url?: any, init?: any) => {
          try {
            if (typeof (extra as any).$fetch === "function") {
              return (extra as any).$fetch(url, init);
            }
            // fallback: dispatch a click on the invoking element to simulate fetch-trigger behavior
            const evt = new Event("click", { bubbles: true, cancelable: true });
            invokingElement.dispatchEvent(evt);
          } catch {
            /* ignore dispatch errors */
          }
        },
      };

      // Accept a small, safe subset of JS-like expressions (single binary/unary forms)
      // and translate them into the internal DSL so authors can write KISS markup such as:
      //   data-hype-show="count > 0"
      // without introducing eval/new Function. This translator is intentionally
      // conservative: it only handles simple binary comparisons and unary '!' on identifiers,
      // numeric literals, booleans and quoted strings on the RHS.
      if (typeof trimmed === "string") {
        // Binary pattern: <identifier> <op> <literal|identifier>
        const binaryMatch = trimmed.match(/^\s*([A-Za-z_$][0-9A-Za-z_$.]*)\s*(===|==|!=|>=|<=|>|<)\s*(.+)\s*$/);
        if (binaryMatch) {
          const lhs = binaryMatch[1];
          const op = binaryMatch[2];
          // Guard against an undefined capture group — ensure we have a string before calling trim()
          let rhsRaw = (binaryMatch[3] || "").trim();
          let rhs: any;
          // numeric literal
          if (/^\d+(\.\d+)?$/.test(rhsRaw)) {
            rhs = Number(rhsRaw);
          } else if (/^(true|false)$/.test(rhsRaw)) {
            rhs = rhsRaw === "true";
          } else if (/^'.*'$/.test(rhsRaw) || /^".*"$/.test(rhsRaw)) {
            // quoted string literal
            rhs = rhsRaw.slice(1, -1);
          } else {
            // treat as state path
            rhs = ["get", rhsRaw];
          }
          try {
            return evalDsl([op, ["get", lhs], rhs], {
              state: context.state,
              pub: this._pub ? (t: string, p?: any) => (this._pub as PubFn)(t, p) : undefined,
              extras,
            });
          } catch (e) {
            // fall through to DSL parsing below if translator fails
          }
        }
        // Unary not: !flag
        const unaryMatch = trimmed.match(/^\!\s*([A-Za-z_$][0-9A-Za-z_$.]*)\s*$/);
        if (unaryMatch) {
          try {
            return evalDsl(["!", ["get", unaryMatch[1]]], {
              state: context.state,
              pub: this._pub ? (t: string, p?: any) => (this._pub as PubFn)(t, p) : undefined,
              extras,
            });
          } catch (e) {
            // fall through
          }
        }
      }

      // If expression looks like DSL JSON, parse and evaluate with evalDsl
      if (isDslString(trimmed)) {
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed as string);
        } catch (err) {
          console.error("[reactive] invalid DSL JSON expression:", expression, err);
          return false;
        }
        return evalDsl(parsed, { state: context.state, pub: this._pub ? (t: string, p?: any) => (this._pub as PubFn)(t, p) : undefined, extras });
      }

      // If expression is a single identifier, treat as named handler
      if (typeof trimmed === "string" && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(trimmed)) {
        const handler = this.handlers[trimmed];
        if (typeof handler === "function") {
          // Prefer state-path attribute on the invoking element (the element that had the handler attribute).
          // The invoking element may be passed via `extra.element` by callers of evaluateExpression.
          const invokingEl: HTMLElement = (extra && (extra as any).element) || context.element;
          const statePath =
            invokingEl.getAttribute(`data-${this.attributePrefix}-rx`) || invokingEl.getAttribute(`data-${this.attributePrefix}-var`) || undefined;
          const current = statePath ? this.getPath(context.state, statePath) : undefined;

          try {
            const handlerCtx = {
              // pass the invoking element (not the component root) so handlers can inspect attributes on the actual element that raised the event
              element: invokingEl,
              // provide event (or $event) to handlers
              event: extra.$event || (extra as any).event,
              statePath,
              reactive: this,
            };
            const maybe = handler(current, handlerCtx);
            if (maybe && typeof (maybe as any).then === "function") {
              // async result: apply when resolved
              return (maybe as Promise<any>).then((res) => {
                if (statePath && res !== undefined) this.setPath(context.state, statePath, res);
                return res;
              });
            } else {
              if (statePath && maybe !== undefined) this.setPath(context.state, statePath, maybe);
              return maybe;
            }
          } catch (err) {
            console.error("[reactive] handler error for", trimmed, err);
            return false;
          }
        }
      }

      // Fallback: treat expression as a simple state path (identifier or dotted path)
      if (typeof trimmed === "string") {
        return this.getPath(context.state, trimmed);
      }

      return false;
    } catch (error) {
      console.error(`Failed to evaluate expression: ${expression}`, error);
      return false;
    }
  }

  /**
   * Safely read nested path from an object. Accepts dot-separated path string
   * or array of path segments.
   */
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

  /**
   * Safely set nested path on an object. Creates intermediate objects if needed.
   */
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

  /**
   * Find the nearest state context for an element
   *
   * Walks up the DOM tree to find the closest ancestor with reactive state.
   * Enables state inheritance from parent components.
   *
   * @private
   * @param {HTMLElement} element - The element to start searching from
   * @returns {StateContext | null} The state context, or null if not found
   */
  private findContext(element: HTMLElement): StateContext | null {
    let current: HTMLElement | null = element;

    while (current) {
      const context = this.contexts.get(current);
      if (context) return context;
      current = current.parentElement;
    }

    return null;
  }

  /**
   * Walk the DOM tree and execute a callback on each element
   *
   * @private
   * @param {HTMLElement} root - The root element to start from
   * @param {(el: HTMLElement) => void} callback - Function to call for each element
   */
  private walkTree(root: HTMLElement, callback: (el: HTMLElement) => void): void {
    callback(root);

    Array.from(root.children).forEach((child) => {
      if (child instanceof HTMLElement) {
        this.walkTree(child, callback);
      }
    });
  }

  /**
   * Debug logging (only outputs when debug mode is enabled)
   *
   * @private
   * @param {...any[]} args - Arguments to log
   */
  private log(...args: any[]): void {
    if (this.debug) {
      console.log("[Hype Reactive]", ...args);
    }
  }

  /**
   * Get the reactive state for an element
   *
   * Useful for debugging or external access to component state.
   * Returns null if the element has no reactive state.
   *
   * @param {HTMLElement} element - The element to get state from
   * @returns {Record<string, any> | null} The state object, or null if not found
   *
   * @example
   * ```typescript
   * const state = reactive.getState(buttonElement);
   * console.log(state.count); // Access state value
   * ```
   */
  getState(element: HTMLElement): Record<string, any> | null {
    const context = this.findContext(element);
    return context ? context.state : null;
  }

  /**
   * Get the current reactive system configuration
   *
   * Exposes a small subset of the ReactiveSystem configuration useful for
   * tests and external integrations (attribute prefix and debug flag).
   *
   * @returns {{ attributePrefix: string; debug: boolean }} The configuration
   *
   * @example
   * ```typescript
   * const cfg = reactive.getConfig();
   * console.log(cfg.attributePrefix);
   * ```
   */
  getConfig(): { attributePrefix: string; debug: boolean } {
    return {
      attributePrefix: this.attributePrefix,
      debug: this.debug,
    };
  }

  /**
   * Update reactive state for an element
   *
   * Merges updates into the existing state and triggers all watchers.
   *
   * @param {HTMLElement} element - The element to update state for
   * @param {Record<string, any>} updates - The state updates to apply
   *
   * @example
   * ```typescript
   * reactive.setState(element, { count: 10, loading: false });
   * ```
   */
  setState(element: HTMLElement, updates: Record<string, any>): void {
    const context = this.findContext(element);
    if (!context) return;

    Object.assign(context.state, updates);
  }

  /**
   * Destroy the reactive system for an element
   *
   * Removes all watchers and cleans up the state context.
   * Should be called when removing elements from the DOM to prevent memory leaks.
   *
   * @param {HTMLElement} element - The element to destroy state for
   *
   * @example
   * ```typescript
   * reactive.destroy(element);
   * element.remove();
   * ```
   */
  destroy(element: HTMLElement): void {
    const context = this.contexts.get(element);
    if (!context) return;

    context.watchers.clear();
    this.contexts.delete(element);
  }
}

/**
 * Create a new reactive system instance
 *
 * Factory function for creating ReactiveSystem instances.
 *
 * @param {Partial<HypeConfig>} config - Configuration options
 * @returns {ReactiveSystem} A new ReactiveSystem instance
 *
 * @example
 * ```typescript
 * import { createReactive } from 'hype';
 *
 * const reactive = createReactive({ debug: true });
 * reactive.init(document.body);
 * ```
 */
export function createReactive(config?: Partial<HypeConfig>): ReactiveSystem {
  return new ReactiveSystem(config);
}
