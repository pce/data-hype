# Hype _DRAFT_

Technical prototype of a pushless HTTP server(less) client protocol for building low-latency, server-driven UIs with declarative client hooks.

Hype is intentionally narrow: it focuses on server-driven markup, deterministic snapshot rendering and a small, predictable runtime to upgrade to live updates.

## Quick start

```html
<script src="/static/js/hype.js" defer></script>

<body data-hype-root>
  <button hype-get="/api/items" hype-target="#list" hype-swap="innerHTML">Load</button>
  <ul id="list"></ul>
</body>
```

No JavaScript required. Drop the script, add attributes, done.

## Scoping

Hype binds to a single root element. All observers and reactive wiring are sandboxed to that root.

```js
// Explicit
const h = createHype({ root: "#app" });

// Or via markup — auto-discovered at boot
// <div data-hype-root="widget-a">…</div>
const h = Hype.instances.get("widget-a");
```

`data-hype-root` variants:

| Markup                        | Effect                                  |
| ----------------------------- | --------------------------------------- |
| `<body data-hype-root>`       | Full-page scope (same as default)       |
| `<main data-hype-root>`       | Scoped subtree only                     |
| `<div data-hype-root="name">` | Named scope, stored in `Hype.instances` |

Multiple `[data-hype-root]` elements each get their own instance. If none are found, Hype falls back to `document.body`.

## Turbo Drive

Mount on a stable element outside Turbo's swap zone:

```html
<body data-hype-root>
  <nav>…</nav>
  <main><!-- Turbo replaces this --></main>
</body>
```

The `MutationObserver` watches `<body>`. When Turbo swaps `<main>`, `addedNodes` fires and Hype re-wires the new content automatically. No glue code needed.

## Attributes

### HTTP methods

| Attribute     | Description        |
| ------------- | ------------------ |
| `hype-get`    | GET request URL    |
| `hype-post`   | POST request URL   |
| `hype-put`    | PUT request URL    |
| `hype-delete` | DELETE request URL |
| `hype-patch`  | PATCH request URL  |

### Targeting

| Attribute     | Description                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `hype-target` | CSS selector for the swap target                                                                                                     |
| `hype-swap`   | Swap strategy: `innerHTML` · `innerText` · `outerHTML` · `beforebegin` · `afterbegin` · `beforeend` · `afterend` · `delete` · `none` |

`innerHTML` is blocked by default. Opt in with `hype-swap="innerHTML"` or server header `X-Hype-Allow-InnerHTML: true`.

### Request

| Attribute       | Description                                  |
| --------------- | -------------------------------------------- |
| `hype-vals`     | Extra form values as JSON                    |
| `hype-headers`  | Extra request headers as JSON                |
| `hype-encoding` | `urlencoded` (default) · `json` · `formdata` |

### UX

| Attribute           | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `hype-trigger`      | Declarative trigger (e.g. `click`, `revealed`)        |
| `hype-confirm`      | Confirmation prompt before request                    |
| `hype-indicator`    | CSS selector for loading indicator element            |
| `hype-disabled-elt` | CSS selector for element(s) to disable during request |
| `hype-push-url`     | Override the URL pushed to browser history            |
| `hype-boost`        | Opt-in progressive enhancement behaviour              |

## Behaviors

Declared via `data-hype-trigger`:

```html
<div data-hype-trigger="revealed" hype-get="/lazy" hype-target="#out">…</div>
<div data-hype-trigger="interval:5000" hype-get="/poll" hype-target="#feed">…</div>
```

Built-ins: `click` · `revealed` · `interval:<ms>` · `scroll-bottom` · `select`

## API

```js
// Factory
const h = createHype(config?, deps?, autoInit?);

// Lifecycle
h.mount(el);       // bind root (immutable once set)
h.run();           // start observers + event delegation
h.scan('#scope');  // manually re-wire a subtree
h.unmount();       // tear down, allow remount
h.destroy();       // full teardown

// Named instances (from data-hype-root="name")
Hype.instances.get('name');
```

## Progressive enhancement

Works without JavaScript — standard form POST, standard links. Hype is an additive layer.

```html
<form action="/api/submit" method="POST" hype-post="/api/submit" hype-target="#result" hype-swap="innerHTML">
  <input name="email" type="email" required />
  <button type="submit">Submit</button>
</form>
```

## Security

- Server is the authority. All auth, validation, and access checks stay server-side.
- Never trust client input. Sanitize all incoming payloads.
- Use `innerText` (the default swap) unless you explicitly need HTML injection.
- Use TLS and `wss://` in production for WebSocket transport.

## Dev

```sh
./dev.sh start
# or
cd playground/dev-server && pnpm install && pnpm run dev
```
