import { describe, it, expect, vi } from 'vitest';
import { InterceptorRegistry, defaultSwap } from '../src/interceptors';
import type { RequestContext, ResponseContext, HttpMethod, SwapStrategy } from '../src/types';

function createMockRequestContext(): RequestContext {
  return {
    element: document.createElement('div'),
    url: '/api/test',
    method: 'POST' as HttpMethod,
    init: {},
    target: document.createElement('div'),
    swap: 'innerHTML' as SwapStrategy,
    data: {},
    abortController: new AbortController(),
  };
}

function createMockResponseContext(): ResponseContext {
  return {
    ...createMockRequestContext(),
    response: new Response('OK', { status: 200 }),
    body: '<div>Test</div>',
    isJson: false,
  };
}

describe('InterceptorRegistry', () => {
  describe('request interceptors', () => {
    it('should add and remove request interceptor', () => {
      const registry = new InterceptorRegistry();
      const interceptor = vi.fn();

      const unregister = registry.addRequestInterceptor(interceptor);
      expect(typeof unregister).toBe('function');

      unregister();
    });

    it('should run request interceptors in order', async () => {
      const registry = new InterceptorRegistry();
      const order: number[] = [];

      registry.addRequestInterceptor((ctx) => {
        order.push(1);
        return ctx;
      });
      registry.addRequestInterceptor((ctx) => {
        order.push(2);
        return ctx;
      });
      registry.addRequestInterceptor((ctx) => {
        order.push(3);
        return ctx;
      });

      const ctx = createMockRequestContext();
      await registry.runRequestInterceptors(ctx);

      expect(order).toEqual([1, 2, 3]);
    });

    it('should allow modifying context in interceptor', async () => {
      const registry = new InterceptorRegistry();

      registry.addRequestInterceptor((ctx) => {
        return { ...ctx, url: '/modified' };
      });

      const ctx = createMockRequestContext();
      const result = await registry.runRequestInterceptors(ctx);

      expect(result.url).toBe('/modified');
    });

    it('should support async interceptors', async () => {
      const registry = new InterceptorRegistry();

      registry.addRequestInterceptor(async (ctx) => {
        await new Promise((r) => setTimeout(r, 10));
        return { ...ctx, url: '/async-modified' };
      });

      const ctx = createMockRequestContext();
      const result = await registry.runRequestInterceptors(ctx);

      expect(result.url).toBe('/async-modified');
    });

    it('should handle interceptor returning void', async () => {
      const registry = new InterceptorRegistry();

      registry.addRequestInterceptor(() => {
        // Return nothing
      });

      const ctx = createMockRequestContext();
      const result = await registry.runRequestInterceptors(ctx);

      expect(result.url).toBe(ctx.url);
    });
  });

  describe('response interceptors', () => {
    it('should add and remove response interceptor', () => {
      const registry = new InterceptorRegistry();
      const interceptor = vi.fn();

      const unregister = registry.addResponseInterceptor(interceptor);
      expect(typeof unregister).toBe('function');

      unregister();
    });

    it('should run response interceptors in order', async () => {
      const registry = new InterceptorRegistry();
      const order: number[] = [];

      registry.addResponseInterceptor((ctx) => {
        order.push(1);
        return ctx;
      });
      registry.addResponseInterceptor((ctx) => {
        order.push(2);
        return ctx;
      });

      const ctx = createMockResponseContext();
      await registry.runResponseInterceptors(ctx);

      expect(order).toEqual([1, 2]);
    });

    it('should allow modifying response context', async () => {
      const registry = new InterceptorRegistry();

      registry.addResponseInterceptor((ctx) => {
        return { ...ctx, body: '<modified>Content</modified>' };
      });

      const ctx = createMockResponseContext();
      const result = await registry.runResponseInterceptors(ctx);

      expect(result.body).toBe('<modified>Content</modified>');
    });
  });

  describe('swap handlers', () => {
    it('should register and get swap handler', () => {
      const registry = new InterceptorRegistry();
      const handler = vi.fn();

      registry.registerSwapHandler('custom', handler);
      expect(registry.getSwapHandler('custom')).toBe(handler);
    });

    it('should unregister swap handler', () => {
      const registry = new InterceptorRegistry();
      const handler = vi.fn();

      const unregister = registry.registerSwapHandler('custom', handler);
      unregister();

      expect(registry.getSwapHandler('custom')).toBeUndefined();
    });

    it('should return undefined for unregistered handler', () => {
      const registry = new InterceptorRegistry();
      expect(registry.getSwapHandler('nonexistent')).toBeUndefined();
    });
  });

  describe('validators', () => {
    it('should register and get validator', () => {
      const registry = new InterceptorRegistry();
      const validator = vi.fn();

      registry.registerValidator('myValidator', validator);
      expect(registry.getValidator('myValidator')).toBe(validator);
    });

    it('should unregister validator', () => {
      const registry = new InterceptorRegistry();
      const validator = vi.fn();

      const unregister = registry.registerValidator('myValidator', validator);
      unregister();

      expect(registry.getValidator('myValidator')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all interceptors and handlers', () => {
      const registry = new InterceptorRegistry();

      registry.addRequestInterceptor(vi.fn());
      registry.addResponseInterceptor(vi.fn());
      registry.registerSwapHandler('custom', vi.fn());
      registry.registerValidator('myValidator', vi.fn());

      registry.clear();

      expect(registry.getSwapHandler('custom')).toBeUndefined();
      expect(registry.getValidator('myValidator')).toBeUndefined();
    });
  });
});

describe('defaultSwap', () => {
  it('should swap innerHTML', () => {
    const target = document.createElement('div');
    target.innerHTML = '<span>Original</span>';

    defaultSwap(target, '<p>New content</p>', 'innerHTML');

    expect(target.innerHTML).toBe('<p>New content</p>');
  });

  it('should swap outerHTML', () => {
    const parent = document.createElement('div');
    const target = document.createElement('span');
    target.id = 'target';
    parent.appendChild(target);

    defaultSwap(target, '<p id="new">Replaced</p>', 'outerHTML');

    expect(parent.innerHTML).toBe('<p id="new">Replaced</p>');
  });

  it('should insert beforebegin', () => {
    const parent = document.createElement('div');
    const target = document.createElement('span');
    target.textContent = 'Original';
    parent.appendChild(target);

    defaultSwap(target, '<p>Before</p>', 'beforebegin');

    expect(parent.innerHTML).toBe('<p>Before</p><span>Original</span>');
  });

  it('should insert afterbegin', () => {
    const target = document.createElement('div');
    target.innerHTML = '<span>Original</span>';

    defaultSwap(target, '<p>First</p>', 'afterbegin');

    expect(target.innerHTML).toBe('<p>First</p><span>Original</span>');
  });

  it('should insert beforeend', () => {
    const target = document.createElement('div');
    target.innerHTML = '<span>Original</span>';

    defaultSwap(target, '<p>Last</p>', 'beforeend');

    expect(target.innerHTML).toBe('<span>Original</span><p>Last</p>');
  });

  it('should insert afterend', () => {
    const parent = document.createElement('div');
    const target = document.createElement('span');
    target.textContent = 'Original';
    parent.appendChild(target);

    defaultSwap(target, '<p>After</p>', 'afterend');

    expect(parent.innerHTML).toBe('<span>Original</span><p>After</p>');
  });

  it('should delete element', () => {
    const parent = document.createElement('div');
    const target = document.createElement('span');
    parent.appendChild(target);

    defaultSwap(target, '', 'delete');

    expect(parent.innerHTML).toBe('');
  });

  it('should do nothing for none strategy', () => {
    const target = document.createElement('div');
    target.innerHTML = '<span>Original</span>';

    defaultSwap(target, '<p>Ignored</p>', 'none');

    expect(target.innerHTML).toBe('<span>Original</span>');
  });

  it('should fall back to innerHTML for unknown strategy', () => {
    const target = document.createElement('div');
    target.innerHTML = '<span>Original</span>';

    defaultSwap(target, '<p>Fallback</p>', 'unknown' as any);

    expect(target.innerHTML).toBe('<p>Fallback</p>');
  });
});
