# Hype  _DRAFT_

This is a technical prototype of pushless http 

## Scope

Hype is intentionally narrow: it focuses on server-driven markup, deterministic snapshot rendering and a small, predictable runtime to upgrade to live updates. 

- markup-first model for live UIs
- progressive enhanced server-rendered or static HTML  
- deterministic client wiring layer for low-latency live updates
- Hype provides primitives for HTTP-driven swaps and optional live patches.
- avoid binding user-supplied markup directly to code hooks
- Keep client hooks declarative and resolved to known, pre-registered functions.
- For richer client logic integrate Hype with a frontend framework; Hype remains the server-side fragment and live-patch primitive.


### Vision  

- Server-first, markup-driven: server-rendered HTML is the canonical state. The server produces usable markup; JavaScript enhances it.
- Tiny deterministic runtime: the backend supplies a single, synchronous runtime artifact. Its responsibility is wiring and transport, not application logic.
- Progressive enhancement: pages are meaningful without JS; live behavior is an additive layer.
- Security-first: assume all client input is untrusted. Enforce auth, validation, and limits server-side.

### Progressive Enhancement

Hype forms/buttons work without JavaScript:

```html
<!-- Works without JS (standard form) -->
<!-- Enhanced with JS (fetch + swap) -->
<form action="/api/submit" method="POST"
      data-hype-post="/api/submit"
      data-hype-target="#result">
  <input name="email" type="email" required>
  <button type="submit">Submit</button>
</form>
```


## Unresolved / TODO
- Data-driven, markup-first interactions remain an open problem when you need richer client expressiveness without a large runtime.
- DSL → JSON: compact client DSLs that serialize to JSON looked attractive but proved hard to keep both lightweight and secure. This is a TODO: explore safe, minimal encodings that remain auditable on the server without dragging significant runtime cost to the browser.
- Do not invent a client DSL until a simple, secure, and small approach is validated.
- plugin pubSub and reveal intersection observer (test), 
- behaviours: throttle/debounce?


### Minimal syntax (overview)

- Mark live regions with `data-hype-live` on server-rendered elements. Use stable `id` attributes for node identity.
- Server → Client messages (examples): `patch` (HTML fragment), `event` (named JSON), `redirect`.
- Client → Server messages (examples): `join`, `event` (structured payload).

### Runtime contract (intended)

- One synchronous script served at `/static/js/hype.js`.
- Deterministic init: examples guard and call `window.hype.init()` explicitly:
  ```js
  if (window.hype && typeof window.hype.init === 'function') window.hype.init();
  ```
- Minimal optional API (examples may use): `hype.sub(name, handler)` / `hype.pub(name, payload)`. Keep the API surface tiny.

## Security guidance (non-negotiable)

- This repo is a local experiment. For any real deployment:
  - Authenticate and authorize live channel joins and actions (session, signed token, etc.)
  - Validate, sanitize, and enforce schemas for all incoming JSON/payloads on the server
  - Apply rate limits, size limits, and transport-level protections
  - Use TLS and `wss://` for secure WebSocket transport in production
- The server is the authority: application logic and access checks must remain server-side 
- CSRF  Example Express middleware

```js
    import csurf from "csurf";
    
    // use cookie-based CSRF tokens
    app.use(cookieParser());
    app.use(csurf({ cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" } }));
    
    // Expose the token for AJAX requests or HTML templates:
    app.get("/csrf-token", (req, res) => {
      res.json({ csrfToken: (req as any).csrfToken() });
    });
    
    // Then client must send the token in a header for mutating requests:
    fetch("/items/1/toggle", {
      method: "POST",
      headers: { "X-CSRF-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({...})
    });
```
    
-  CSP

```js
    import crypto from "crypto";
    import { Request, Response, NextFunction } from "express";
    
    function generateNonce() {
      return crypto.randomBytes(16).toString("base64");
    }
    
    export function securityMiddleware(req: Request, res: Response, next: NextFunction) {
      const nonce = generateNonce();
      // make it available to templates/static-rendering
      (res.locals as any).cspNonce = nonce;
    
      // Example CSP: allow same-origin and scripts only with nonce
      const csp = [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; ");
    
      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
    
      next();
    }
```



## Quick start (dev)

- helper (docker):
  ./dev.sh start
  - Builds the runtime, copies it to `playground/dev-server/public/static/js`, and starts the dev server (default port 3000).
- Or run the dev-server directly:
  cd hype/playground/dev-server
  pnpm install
  pnpm run dev
