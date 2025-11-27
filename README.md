# hype


A minimal hyperscript like progressive-enhancement fetch enhancer.

[![CI](https://github.com/pce/hype/actions/workflows/ci.yml/badge.svg)](https://github.com/pce/hype/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/hype.svg)](https://www.npmjs.com/package/hype)

## Features

- **Progressive Enhancement First**: Works without JavaScript (forms/links fall back to server), enhanced with fetch when JS is present
- **HTTP Verb Attributes** for semantic HTTP operations
- **JSON Response Directives**: Handle `{ html, redirect, target, swap, settle }` for server-driven UI updates
- **React Compatible**: Safe to use alongside React (no global state pollution, respects React's DOM changes)
- **HTML5 Semantic**: Extends standard HTML attributes naturally



## Installation

```bash
# npm
npm install hype

# pnpm
pnpm add hype

# bun
bun add hype
```

### CDN / Browser

```html
<!-- IIFE for direct browser use -->
<script src="https://unpkg.com/hype/dist/hype.iife.min.js"></script>
<script>
  Hype.hype.init();
</script>

<!-- Or as ES module -->
<script type="module">
  import { hype } from 'https://unpkg.com/hype/dist/hype.min.js';
  hype.init();
</script>
```

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <title>Hype Example</title>
</head>
<body>
  <!-- Form that works without JS, enhanced with JS -->
  <form action="/api/submit" method="POST" 
        hype-post="/api/submit" 
        hype-target="#result" 
        hype-swap="innerHTML">
    <input name="email" type="email" required>
    <button type="submit">Subscribe</button>
  </form>
  
  <div id="result"></div>

  <script type="module">
    import { hype } from 'hype';
    hype.init();
  </script>
</body>
</html>
```

## Usage

### Basic Attributes

```html
<!-- GET request -->
<button hype-get="/api/users" hype-target="#users">Load Users</button>

<!-- POST request -->
<form hype-post="/api/users" hype-target="#result">
  <input name="name" required>
  <button type="submit">Create</button>
</form>

<!-- PUT request -->
<form hype-put="/api/users/1" hype-target="#user-1">
  <input name="name" value="Updated Name">
  <button type="submit">Update</button>
</form>

<!-- DELETE request -->
<button hype-delete="/api/users/1" hype-swap="outerHTML">Delete</button>

<!-- PATCH request -->
<form hype-patch="/api/users/1" hype-target="#user-status">
  <input name="status" value="active">
  <button type="submit">Update Status</button>
</form>
```

### Swap Strategies

```html
<!-- Replace inner HTML (default) -->
<div hype-get="/api/content" hype-swap="innerHTML">...</div>

<!-- Replace entire element -->
<div hype-get="/api/content" hype-swap="outerHTML">...</div>

<!-- Insert before/after -->
<ul id="list">
  <button hype-post="/api/items" hype-target="#list" hype-swap="beforeend">
    Add Item
  </button>
</ul>

<!-- Delete element -->
<button hype-delete="/api/item/1" hype-swap="delete">Delete</button>

<!-- Do nothing (useful for side effects) -->
<button hype-post="/api/track" hype-swap="none">Track</button>
```

Supported swap strategies:
- `innerHTML` - Replace target's inner HTML
- `outerHTML` - Replace target element entirely
- `beforebegin` - Insert before target
- `afterbegin` - Insert as first child
- `beforeend` - Insert as last child
- `afterend` - Insert after target
- `delete` - Remove the target element
- `none` - Don't modify DOM

### JSON Response Handling

Server can return JSON with directives:

```json
{
  "html": "<p>Updated content</p>",
  "target": "#specific-element",
  "swap": "innerHTML",
  "settle": 100,
  "redirect": "/new-page"
}
```

### Progressive Enhancement

Hype forms/buttons work without JavaScript:

```html
<!-- Works without JS (standard form) -->
<!-- Enhanced with JS (fetch + swap) -->
<form action="/api/submit" method="POST"
      hype-post="/api/submit"
      hype-target="#result">
  <input name="email" type="email" required>
  <button type="submit">Submit</button>
</form>
```

### JavaScript API

```typescript
import { createHype, Hype } from 'hype';

// Create instance with config
const hype = createHype({
  defaultSwap: 'innerHTML',
  timeout: 30000,
  credentials: 'same-origin',
  dedupe: 'cancel',
  debug: false,
});

// Initialize (sets up event listeners)
hype.init();

// Add request interceptor
const removeInterceptor = hype.onRequest((ctx) => {
  ctx.init.headers = {
    ...ctx.init.headers,
    'X-Custom-Header': 'value',
  };
  return ctx;
});

// Add response interceptor
hype.onResponse((ctx) => {
  console.log('Response:', ctx.response.status);
  return ctx;
});

// Register custom swap handler
hype.registerSwap('morph', (target, html) => {
  // Use morphdom or similar
  morphdom(target, html);
});

// Register custom validator
hype.registerValidator('custom', (form, formData) => {
  const email = formData.get('email');
  if (!email?.toString().includes('@')) {
    return 'Invalid email';
  }
  return true;
});

// Trigger request programmatically
await hype.trigger(document.getElementById('my-form'));

// Update configuration
hype.configure({ debug: true });

// Clean up
hype.destroy();
```

### Events

Hype dispatches custom events for fine-grained control:

```javascript
// Before request is made (cancellable)
document.addEventListener('hype:before-request', (e) => {
  console.log('Request to:', e.detail.context.url);
  // e.detail.cancel(); // Cancel the request
  // e.preventDefault(); // Also cancels
});

// Before DOM swap (cancellable)
document.addEventListener('hype:before-swap', (e) => {
  console.log('Swapping HTML:', e.detail.html);
  e.detail.html = e.detail.html.toUpperCase(); // Modify HTML
});

// After swap completes
document.addEventListener('hype:after-swap', (e) => {
  console.log('Swapped into:', e.detail.target);
});

// After settle delay
document.addEventListener('hype:after-settle', (e) => {
  // DOM is fully settled
});

// Request error (network failure, timeout)
document.addEventListener('hype:request-error', (e) => {
  console.error('Request failed:', e.detail.error);
});

// Response error (non-2xx status)
document.addEventListener('hype:response-error', (e) => {
  console.error('Response error:', e.detail.error);
});
```

### Additional Attributes

```html
<!-- Custom target -->
<button hype-get="/api/data" hype-target="#container">Load</button>

<!-- Confirmation dialog -->
<button hype-delete="/api/item/1" hype-confirm="Are you sure?">Delete</button>

<!-- Loading indicator -->
<button hype-post="/api/slow" hype-indicator="#spinner">Submit</button>
<span id="spinner" class="hidden">Loading...</span>

<!-- Disable elements during request -->
<form hype-post="/api/submit" hype-disabled-elt="button">
  <button type="submit">Submit</button>
</form>

<!-- Custom headers -->
<button hype-get="/api/data" hype-headers='{"X-Custom":"value"}'>Load</button>

<!-- Additional values -->
<button hype-post="/api/action" hype-vals='{"extra":"data"}'>Action</button>

<!-- JSON encoding -->
<form hype-post="/api/json" hype-encoding="application/json">
  <input name="data">
  <button type="submit">Submit</button>
</form>

<!-- URL push -->
<a hype-get="/page" hype-push-url="/page" hype-target="#content">Link</a>

<!-- Boost regular links/forms -->
<a href="/page" hype-boost hype-target="#content">Enhanced Link</a>
```

### Usage with React

```jsx
import { useEffect, useRef } from 'react';
import { createHype } from 'hype';

function HypeForm() {
  const containerRef = useRef(null);
  const hypeRef = useRef(null);

  useEffect(() => {
    // Create isolated instance for this component
    hypeRef.current = createHype({ 
      debug: false,
      defaultSwap: 'innerHTML',
    });
    hypeRef.current.init();

    return () => {
      hypeRef.current?.destroy();
    };
  }, []);

  return (
    <div ref={containerRef}>
      <form 
        action="/api/submit" 
        method="POST"
        hype-post="/api/submit" 
        hype-target="#result"
      >
        <input name="email" type="email" required />
        <button type="submit">Subscribe</button>
      </form>
      <div id="result"></div>
    </div>
  );
}
```

### TypeScript

Full TypeScript support with exported types:

```typescript
import { 
  Hype, 
  createHype,
  type HypeConfig,
  type RequestContext,
  type ResponseContext,
  type RequestInterceptor,
  type ResponseInterceptor,
  type SwapHandler,
  type SwapStrategy,
  type HttpMethod,
} from 'hype';

const config: Partial<HypeConfig> = {
  defaultSwap: 'innerHTML',
  timeout: 5000,
};

const hype = createHype(config);

const myInterceptor: RequestInterceptor = (ctx: RequestContext) => {
  console.log(`${ctx.method} ${ctx.url}`);
  return ctx;
};

hype.onRequest(myInterceptor);
```

## Configuration

```typescript
interface HypeConfig {
  // Default swap strategy
  defaultSwap: SwapStrategy; // default: 'innerHTML'
  
  // Default target selector
  defaultTarget?: string;
  
  // Settle delay in ms after swap
  settleDelay: number; // default: 20
  
  // Fetch timeout in ms
  timeout: number; // default: 30000
  
  // Fetch credentials mode
  credentials: RequestCredentials; // default: 'same-origin'
  
  // Default headers for all requests
  headers: Record<string, string>; // default: { 'X-Requested-With': 'XMLHttpRequest' }
  
  // Throw on non-2xx responses
  throwOnHttpError: boolean; // default: false
  
  // Request deduplication: 'cancel' previous, 'ignore' new, or 'allow' all
  dedupe: 'cancel' | 'ignore' | 'allow'; // default: 'cancel'
  
  // History handling: 'push', 'replace', or false
  history: 'push' | 'replace' | false; // default: false
  
  // Attribute prefix
  attributePrefix: string; // default: 'hype'
  
  // Enable debug logging
  debug: boolean; // default: false
}
```

## Build Outputs

- `dist/hype.js` - ES module
- `dist/hype.min.js` - ES module (minified)
- `dist/hype.cjs` - CommonJS
- `dist/hype.min.cjs` - CommonJS (minified)
- `dist/hype.iife.js` - IIFE/UMD for browsers
- `dist/hype.iife.min.js` - IIFE/UMD (minified)
- `dist/hype.d.ts` - TypeScript declarations

## Development

### Local Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Build
pnpm build

# Development mode (watch)
pnpm dev

# Type check
pnpm lint

# Generate documentation
pnpm docs

# Serve documentation locally (generates and opens in browser)
pnpm docs:serve
```

### Docker Build

Build the project in a reproducible Docker environment:

```bash
# Build the project
docker-compose up build

# Run tests
docker-compose run --rm test

# Run tests with coverage
docker-compose run --rm test-coverage

# Development mode (watch)
docker-compose run --rm dev

# Generate documentation (outputs to ./docs-output)
docker-compose up docs

# Interactive shell
docker-compose run --rm shell
```

After generating docs with Docker, view them locally:
```bash
npx http-server docs-output -p 8080 -o
```

See [DOCKER.md](DOCKER.md) for detailed Docker instructions.

### Documentation

- **API Documentation**: [GitHub Pages](https://pce.github.io/hype/) (auto-generated from JSDoc)
- **Reactive System**: See [REACTIVE.md](REACTIVE.md)
- **Docker Guide**: See [DOCKER.md](DOCKER.md)

## License

MIT
