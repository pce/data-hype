import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHype, Hype } from '../src/hype';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Integration tests', () => {
  let hype: Hype;
  const listeners: Array<{target: EventTarget; type: string; handler: EventListenerOrEventListenerObject}> = [];

  function addListener(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject) {
    target.addEventListener(type, handler);
    listeners.push({target, type, handler});
  }

  beforeEach(() => {
    hype = createHype({ debug: false, settleDelay: 0 });
    hype.init();
    mockFetch.mockReset();
  });

  afterEach(() => {
    hype.destroy();
    document.body.innerHTML = '';
    // Clean up all event listeners
    for (const {target, type, handler} of listeners) {
      target.removeEventListener(type, handler);
    }
    listeners.length = 0;
  });

  describe('Form submission', () => {
    it('should submit form with hype-post and update target', async () => {
      document.body.innerHTML = `
        <form id="test-form" hype-post="/api/submit" hype-target="#result" hype-swap="innerHTML">
          <input name="name" value="John">
          <button type="submit">Submit</button>
        </form>
        <div id="result"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<p>Success!</p>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const form = document.getElementById('test-form') as HTMLFormElement;

      // Trigger form submission through hype
      await hype.trigger(form);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/submit');
      expect(init.method).toBe('POST');

      // Wait for swap to complete
      await new Promise((r) => setTimeout(r, 50));

      const result = document.getElementById('result');
      expect(result?.innerHTML).toBe('<p>Success!</p>');
    });

    it('should handle GET form with query params', async () => {
      document.body.innerHTML = `
        <form id="search-form" hype-get="/api/search" hype-target="#results">
          <input name="q" value="test query">
          <button type="submit">Search</button>
        </form>
        <div id="results"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<div>Results</div>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const form = document.getElementById('search-form') as HTMLFormElement;
      await hype.trigger(form);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/search?');
      expect(url).toContain('q=test+query');
    });
  });

  describe('Button clicks', () => {
    it('should handle button with hype-get', async () => {
      document.body.innerHTML = `
        <button id="load-btn" hype-get="/api/data" hype-target="#container">Load</button>
        <div id="container"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<div>Loaded content</div>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const button = document.getElementById('load-btn') as HTMLButtonElement;
      await hype.trigger(button);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/data');
      expect(init.method).toBe('GET');
    });

    it('should handle button with hype-delete', async () => {
      document.body.innerHTML = `
        <button id="delete-btn" hype-delete="/api/item/123" hype-swap="outerHTML">Delete</button>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const button = document.getElementById('delete-btn') as HTMLButtonElement;
      await hype.trigger(button);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/item/123');
      expect(init.method).toBe('DELETE');
    });
  });

  describe('JSON responses', () => {
    it('should handle JSON response with html directive', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-post="/api/action" hype-target="#output">Click</button>
        <div id="output"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ html: '<span>From JSON</span>' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      const output = document.getElementById('output');
      expect(output?.innerHTML).toBe('<span>From JSON</span>');
    });

    it('should handle JSON response with target override', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-post="/api/action" hype-target="#original">Click</button>
        <div id="original"></div>
        <div id="overridden"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html: '<span>Targeted</span>',
            target: '#overridden',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById('original')?.innerHTML).toBe('');
      expect(document.getElementById('overridden')?.innerHTML).toBe('<span>Targeted</span>');
    });

    it('should handle JSON response with swap override', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-post="/api/action" hype-target="#container" hype-swap="innerHTML">Click</button>
        <div id="container"><span>Original</span></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html: '<p>Added</p>',
            swap: 'beforeend',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      const container = document.getElementById('container');
      expect(container?.innerHTML).toBe('<span>Original</span><p>Added</p>');
    });

    it('should handle JSON response with redirect', async () => {
      const originalHref = window.location.href;
      const mockAssign = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { href: originalHref, assign: mockAssign },
        writable: true,
      });

      document.body.innerHTML = `
        <button id="btn" hype-post="/api/action">Click</button>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ redirect: '/new-page' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(window.location.href).toBe('/new-page');
    });
  });

  describe('Interceptors', () => {
    it('should run request interceptors', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data">Click</button>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('OK', { status: 200 })
      );

      const interceptorCalled = vi.fn();
      hype.onRequest((ctx) => {
        interceptorCalled(ctx.url);
        return { ...ctx, url: '/api/modified' };
      });

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      expect(interceptorCalled).toHaveBeenCalledWith('/api/data');
      expect(mockFetch).toHaveBeenCalledWith('/api/modified', expect.anything());
    });

    it('should run response interceptors', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data" hype-target="#output">Click</button>
        <div id="output"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<div>Original</div>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      hype.onResponse((ctx) => {
        if (typeof ctx.body === 'string') {
          return { ...ctx, body: ctx.body.replace('Original', 'Modified') };
        }
        return ctx;
      });

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById('output')?.innerHTML).toBe('<div>Modified</div>');
    });
  });

  describe('Events', () => {
    it('should dispatch hype:before-request event', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data">Click</button>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('OK', { status: 200 })
      );

      const eventHandler = vi.fn();
      addListener(document.body, 'hype:before-request', eventHandler);

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      expect(eventHandler).toHaveBeenCalled();
    });

    it('should allow cancelling request via event', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data">Click</button>
      `;

      addListener(document.body, 'hype:before-request', (e: Event) => {
        (e as CustomEvent).detail.cancel();
      });

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should dispatch hype:after-swap event', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data" hype-target="#output">Click</button>
        <div id="output"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<div>Content</div>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const eventHandler = vi.fn();
      addListener(document.body, 'hype:after-swap', eventHandler);

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(eventHandler).toHaveBeenCalled();
    });
  });

  describe('Swap strategies', () => {
    it('should use outerHTML swap', async () => {
      document.body.innerHTML = `
        <div id="container">
          <button id="btn" hype-get="/api/data" hype-swap="outerHTML">Replace Me</button>
        </div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<span id="replaced">Replaced</span>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById('btn')).toBeNull();
      expect(document.getElementById('replaced')).not.toBeNull();
    });

    it('should use beforeend swap', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data" hype-target="#list" hype-swap="beforeend">Add</button>
        <ul id="list"><li>Item 1</li></ul>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<li>Item 2</li>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById('list')?.innerHTML).toBe('<li>Item 1</li><li>Item 2</li>');
    });

    it('should use custom swap handler', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data" hype-target="#output" hype-swap="custom">Click</button>
        <div id="output"></div>
      `;

      mockFetch.mockResolvedValueOnce(
        new Response('<div>Content</div>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      hype.registerSwap('custom', (target, html) => {
        target.innerHTML = `<custom>${html}</custom>`;
      });

      const button = document.getElementById('btn') as HTMLButtonElement;
      await hype.trigger(button);

      await new Promise((r) => setTimeout(r, 50));

      expect(document.getElementById('output')?.innerHTML).toBe('<custom><div>Content</div></custom>');
    });
  });

  describe('Loading states', () => {
    it('should add loading class during request', async () => {
      document.body.innerHTML = `
        <button id="btn" hype-get="/api/slow">Click</button>
      `;

      let resolveRequest: (r: Response) => void = () => {};
      mockFetch.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      const button = document.getElementById('btn') as HTMLButtonElement;
      const triggerPromise = hype.trigger(button);

      // Check loading state
      await new Promise((r) => setTimeout(r, 10));
      expect(button.classList.contains('hype-loading')).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');

      // Resolve request
      resolveRequest(new Response('OK', { status: 200 }));
      await triggerPromise;

      // Check loading state removed
      await new Promise((r) => setTimeout(r, 10));
      expect(button.classList.contains('hype-loading')).toBe(false);
      expect(button.getAttribute('aria-busy')).toBeNull();
    });
  });

  describe('Request deduplication', () => {
    it('should cancel previous request with dedupe: cancel', async () => {
      const instance = createHype({ dedupe: 'cancel', settleDelay: 0 });
      instance.init();

      document.body.innerHTML = `
        <button id="btn" hype-get="/api/data">Click</button>
      `;

      const abortControllers: AbortController[] = [];
      mockFetch.mockImplementation((url: string, init: RequestInit) => {
        if (init.signal) {
          // Track abort signals
          (init.signal as AbortSignal).addEventListener('abort', () => {
            // Request was aborted
          });
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(new Response('OK', { status: 200 }));
          }, 100);
        });
      });

      const button = document.getElementById('btn') as HTMLButtonElement;

      // Trigger two requests quickly
      const promise1 = instance.trigger(button);
      await new Promise((r) => setTimeout(r, 10));
      const promise2 = instance.trigger(button);

      await Promise.all([promise1, promise2]);

      // Both requests were made, but first was cancelled
      expect(mockFetch).toHaveBeenCalledTimes(2);

      instance.destroy();
    });
  });
});
