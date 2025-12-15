/**
 * Small JSON-based DSL evaluator for Hype reactive expressions.
 *
 * The DSL is intentionally minimal and auditable. Expressions are represented
 * as JSON arrays/objects and evaluated by this interpreter without using
 * the Function constructor or eval.
 *
 * Example:
 *   ["set", "count", ["+", ["get", "count"], 1]]
 *
 * Supported operators:
 *  - Arithmetic: "+", "-", "*", "/", "%"
 *  - Comparisons: "==", "===", "!=", ">", "<", ">=", "<="
 *  - Logical: "&&", "||", "!"
 *  - Ternary: "?:"
 *  - Sequencing: "seq" (evaluate in order, return last)
 *  - State helpers: "get", "set", "toggle"
 *  - Pub: "pub" (delegates to ctx.pub if provided)
 *  - hasClass: "hasClass" (checks element class via extras.$el or provided element)
 *  - fetch: "fetch" (delegates to extras.$fetch or global fetch)
 *
 * Literals: numbers, strings, booleans, null, arrays (as expressions or literals),
 * and objects (each property evaluated).
 */

export type DslNode = any;

export interface EvalContext {
  state: Record<string, any>;
  /**
   * Optional pub function. If provided, ["pub", topic, payload?] will call this.
   */
  pub?: (topic: string, payload?: any) => any;
  /**
   * Optional helper map for future extension.
   */
  helpers?: Record<string, (...args: any[]) => any>;
  /**
   * Extras allow callers to pass runtime objects like $el, $event or $fetch.
   * Example: evalDsl(parsed, { state, extras: { $el: el, $fetch: fetchFn } })
   */
  extras?: Record<string, any>;
}

/**
 * Safely read nested path from an object. Accepts dot-separated path string
 * or array of path segments.
 */
function getPath(obj: any, path: string | string[]): any {
  if (path == null) return undefined;
  const parts: string[] = Array.isArray(path) ? (path as string[]) : String(path).split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    // index with a string type assertion to satisfy TS index typing
    cur = cur[p as string];
  }
  return cur;
}

/**
 * Safely set nested path on an object. Creates intermediate objects if needed.
 */
function setPath(obj: any, path: string | string[], value: any): void {
  const parts: string[] = Array.isArray(path) ? (path as string[]) : String(path).split(".");
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    // ensure intermediate objects exist and use string index assertion
    if (cur[p as string] == null || typeof cur[p as string] !== "object") cur[p as string] = {};
    cur = cur[p as string];
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) {
    cur[last as string] = value;
  }
}

/**
 * Heuristic to detect if an expression string looks like DSL JSON.
 * (Used by callers who accept either DSL JSON or JS string expressions.)
 */
export function isDslString(expr: any): boolean {
  if (typeof expr !== "string") return false;
  const t = expr.trim();
  // DSL expressions are valid JSON arrays or objects at the top-level
  return t.startsWith("[") || t.startsWith("{");
}

/**
 * Evaluate a DSL node.
 *
 * The interpreter intentionally supports a small whitelist of operations.
 * Any unsupported shapes return undefined.
 */
export function evalDsl(node: DslNode, ctx: EvalContext): any {
  // Primitive literals
  if (node === null || typeof node === "number" || typeof node === "string" || typeof node === "boolean") {
    return node;
  }

  // Arrays represent operator forms or array literals.
  if (Array.isArray(node)) {
    if (node.length === 0) return [];

    const op = node[0];

    // If the first element is not a recognized op, treat as array literal.
    const isOp =
      typeof op === "string" &&
      [
        "+",
        "-",
        "*",
        "/",
        "%",
        "==",
        "===",
        "!=",
        ">",
        "<",
        ">=",
        "<=",
        "&&",
        "||",
        "!",
        "?:",
        "seq",
        "get",
        "set",
        "toggle",
        "pub",
        "hasClass",
        "fetch",
      ].includes(op);

    if (!isOp) {
      // evaluate each element and return array
      return node.map((n) => evalDsl(n, ctx));
    }

    switch (op) {
      // Arithmetic
      case "+":
        return node.slice(1).reduce((acc, n) => acc + evalDsl(n, ctx), 0);
      case "-": {
        if (node.length === 2) return -evalDsl(node[1], ctx);
        let acc = evalDsl(node[1], ctx);
        for (let i = 2; i < node.length; i++) acc -= evalDsl(node[i], ctx);
        return acc;
      }
      case "*":
        return node.slice(1).reduce((acc, n) => acc * evalDsl(n, ctx), 1);
      case "/": {
        let acc = evalDsl(node[1], ctx);
        for (let i = 2; i < node.length; i++) acc = acc / evalDsl(node[i], ctx);
        return acc;
      }
      case "%":
        return evalDsl(node[1], ctx) % evalDsl(node[2], ctx);

      // Comparisons
      case "==":
        return evalDsl(node[1], ctx) == evalDsl(node[2], ctx);
      case "===":
        return evalDsl(node[1], ctx) === evalDsl(node[2], ctx);
      case "!=":
        return evalDsl(node[1], ctx) != evalDsl(node[2], ctx);
      case ">":
        return evalDsl(node[1], ctx) > evalDsl(node[2], ctx);
      case "<":
        return evalDsl(node[1], ctx) < evalDsl(node[2], ctx);
      case ">=":
        return evalDsl(node[1], ctx) >= evalDsl(node[2], ctx);
      case "<=":
        return evalDsl(node[1], ctx) <= evalDsl(node[2], ctx);

      // Logical
      case "&&": {
        const a = evalDsl(node[1], ctx);
        return a ? evalDsl(node[2], ctx) : a;
      }
      case "||": {
        const a = evalDsl(node[1], ctx);
        return a ? a : evalDsl(node[2], ctx);
      }
      case "!":
        return !evalDsl(node[1], ctx);

      // Ternary: ["?:", cond, trueExpr, falseExpr]
      case "?:": {
        const cond = evalDsl(node[1], ctx);
        return cond ? evalDsl(node[2], ctx) : evalDsl(node[3], ctx);
      }

      // Sequence: evaluate each expression and return last result
      case "seq": {
        let result: any = undefined;
        for (let i = 1; i < node.length; i++) {
          result = evalDsl(node[i], ctx);
        }
        return result;
      }

      // State helpers
      case "get": {
        const pathNode = node[1];
        // allow either literal path or evaluated path
        const path = typeof pathNode === "string" ? pathNode : evalDsl(pathNode, ctx);

        // Support $-prefixed extras paths, e.g. ["get", "$event.target.value"]
        // This lets DSL access runtime extras passed by the caller (like $event, $el).
        if (typeof path === "string" && path.startsWith("$")) {
          // split "$event.target.value" -> ["$event","target","value"]
          const parts = path.split(".");
          // defensive: ensure parts[0] exists
          const top = parts.length > 0 ? parts[0] : undefined; // e.g. "$event"
          if (!top) return undefined;
          const rest = parts.slice(1).join("."); // e.g. "target.value"
          // strip leading '$' if present to match keys placed into ctx.extras
          const key = top.startsWith("$") ? top.slice(1) : top; // "event"
          const base = ctx.extras ? (ctx.extras as any)[key] : undefined;
          if (rest) return getPath(base, rest);
          return base;
        }

        return getPath(ctx.state, path);
      }

      case "set": {
        const pathNode = node[1];
        const valNode = node[2];
        const path = typeof pathNode === "string" ? pathNode : evalDsl(pathNode, ctx);
        const val = evalDsl(valNode, ctx);
        // Debug: log set operations to help diagnose reactive failures
        setPath(ctx.state, path, val);
        return val;
      }

      case "toggle": {
        const pathNode = node[1];
        const path = typeof pathNode === "string" ? pathNode : evalDsl(pathNode, ctx);
        const cur = getPath(ctx.state, path);
        const next = !cur;
        // Debug: log toggle operations to help diagnose reactive visibility issues
        setPath(ctx.state, path, next);
        return next;
      }

      // Pub/sub
      case "pub": {
        // topic can be literal or expression
        const topic = evalDsl(node[1], ctx);
        const payload = node.length > 2 ? evalDsl(node[2], ctx) : undefined;
        if (typeof ctx.pub === "function") {
          try {
            return ctx.pub(topic, payload);
          } catch {
            // swallow pub errors; DSL should not throw for pub failures
            return undefined;
          }
        }
        return undefined;
      }

      // hasClass: check class presence on element (from extras.$el or provided element)
      // Usage: ["hasClass", "className"] or ["hasClass", "className", elementNode]
      case "hasClass": {
        const className = evalDsl(node[1], ctx);
        let el: any = undefined;
        if (node.length > 2) {
          el = evalDsl(node[2], ctx);
        } else if (ctx.extras && ctx.extras.$el) {
          el = ctx.extras.$el;
        }
        try {
          return !!(el && el.classList && el.classList.contains && el.classList.contains(className));
        } catch {
          return false;
        }
      }

      // fetch: delegates to extras.$fetch if provided, otherwise attempts global fetch
      // Usage: ["fetch", url, init?]
      case "fetch": {
        const url = evalDsl(node[1], ctx);
        const init = node.length > 2 ? evalDsl(node[2], ctx) : undefined;
        try {
          if (ctx.extras && typeof ctx.extras.$fetch === "function") {
            return ctx.extras.$fetch(url, init);
          }
          if (typeof fetch === "function") {
            return fetch(url, init);
          }
        } catch {
          // swallow fetch errors for DSL safety
          return undefined;
        }
        return undefined;
      }

      default:
        // Unknown op - defensive: return undefined
        return undefined;
    }
  }

  // Objects: evaluate each property (useful for building structured payloads)
  if (typeof node === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(node)) {
      out[k] = evalDsl(node[k], ctx);
    }
    return out;
  }

  // Fallback for unsupported node types
  return undefined;
}
