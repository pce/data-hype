// @ts-nocheck
import { describe, it, expect, beforeEach } from 'vitest';
import { EventSystem } from '../src/events';
import type { RequestContext, ResponseContext, HttpMethod, SwapStrategy } from '../src/types';

function createMockElement(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function createMockRequestContext(element: HTMLElement): RequestContext {
  return {
    element,
    url: '/api/test',
    method: 'POST' as HttpMethod,
    init: {},
    target: element,
    swap: 'innerHTML' as SwapStrategy,
    data: {},
    abortController: new AbortController(),
  };
}

function createMockResponseContext(element: HTMLElement): ResponseContext {
  return {
    ...createMockRequestContext(element),
    response: new Response('OK', { status: 200 }),
    body: '<div>Test</div>',
    isJson: false,
  };
}

describe('EventSystem', () => {
  let events: EventSystem;

  beforeEach(() => {
    events = new EventSystem(false);
    document.body.innerHTML = '';
  });

  describe('dispatch', () => {
    it('should dispatch custom event on element', () => {
      const element = createMockElement();
      let dispatched = false;

      element.addEventListener('hype:before-request', () => {
        dispatched = true;
      });

      const ctx = createMockRequestContext(element);
      events.dispatch(element, 'hype:before-request', { context: ctx, cancel: () => {} });
      expect(dispatched).toBe(true);
    });

    it('should bubble events', () => {
      const parent = document.createElement('div');
      const child = document.createElement('span');
      parent.appendChild(child);
      document.body.appendChild(parent);

      let bubbled = false;
      parent.addEventListener('hype:after-swap', () => {
        bubbled = true;
      });

      const ctx = createMockResponseContext(child);
      events.dispatch(child, 'hype:after-swap', { context: ctx, target: child });
      expect(bubbled).toBe(true);
    });

    it('should return false when event is cancelled', () => {
      const element = createMockElement();

      element.addEventListener('hype:before-request', (e) => {
        e.preventDefault();
      });

      const ctx = createMockRequestContext(element);
      const result = events.dispatch(element, 'hype:before-request', { context: ctx, cancel: () => {} });
      expect(result).toBe(false);
    });
  });

  describe('dispatchBeforeRequest', () => {
    it('should return context when not cancelled', () => {
      const element = createMockElement();
      const ctx = createMockRequestContext(element);

      const result = events.dispatchBeforeRequest(ctx);
      expect(result).not.toBeNull();
      expect(result?.url).toBe('/api/test');
    });

    it('should return null when cancelled via cancel()', () => {
      const element = createMockElement();
      const ctx = createMockRequestContext(element);

      element.addEventListener('hype:before-request', (e) => {
        const detail = (e as CustomEvent).detail;
        detail.cancel();
      });

      const result = events.dispatchBeforeRequest(ctx);
      expect(result).toBeNull();
    });

    it('should return null when preventDefault is called', () => {
      const element = createMockElement();
      const ctx = createMockRequestContext(element);

      element.addEventListener('hype:before-request', (e) => {
        e.preventDefault();
      });

      const result = events.dispatchBeforeRequest(ctx);
      expect(result).toBeNull();
    });
  });

  describe('dispatchBeforeSwap', () => {
    it('should return html when not cancelled', () => {
      const element = createMockElement();
      const ctx = createMockResponseContext(element);

      const result = events.dispatchBeforeSwap(ctx, '<p>Test</p>');
      expect(result).toBe('<p>Test</p>');
    });

    it('should allow modifying html in event handler', () => {
      const element = createMockElement();
      const ctx = createMockResponseContext(element);

      element.addEventListener('hype:before-swap', (e) => {
        const detail = (e as CustomEvent).detail;
        detail.html = '<p>Modified</p>';
      });

      const result = events.dispatchBeforeSwap(ctx, '<p>Original</p>');
      expect(result).toBe('<p>Modified</p>');
    });

    it('should return null when cancelled', () => {
      const element = createMockElement();
      const ctx = createMockResponseContext(element);

      element.addEventListener('hype:before-swap', (e) => {
        const detail = (e as CustomEvent).detail;
        detail.cancel();
      });

      const result = events.dispatchBeforeSwap(ctx, '<p>Test</p>');
      expect(result).toBeNull();
    });
  });

  describe('dispatchAfterSwap', () => {
    it('should dispatch after-swap event', () => {
      const element = createMockElement();
      const ctx = createMockResponseContext(element);

      let received = false;
      element.addEventListener('hype:after-swap', (e) => {
        const detail = (e as CustomEvent).detail;
        received = detail.target === element;
      });

      events.dispatchAfterSwap(ctx, element);
      expect(received).toBe(true);
    });
  });

  describe('dispatchAfterSettle', () => {
    it('should dispatch after-settle event', () => {
      const element = createMockElement();
      const ctx = createMockResponseContext(element);

      let received = false;
      element.addEventListener('hype:after-settle', () => {
        received = true;
      });

      events.dispatchAfterSettle(ctx, element);
      expect(received).toBe(true);
    });
  });

  describe('dispatchRequestError', () => {
    it('should dispatch request-error event with error', () => {
      const element = createMockElement();
      const ctx = createMockRequestContext(element);
      const error = new Error('Test error');

      let receivedError: Error | null = null;
      element.addEventListener('hype:request-error', (e) => {
        receivedError = (e as CustomEvent).detail.error;
      });

      events.dispatchRequestError(ctx, error);
      expect(receivedError).toBe(error);
    });
  });

  describe('dispatchResponseError', () => {
    it('should dispatch response-error event with error', () => {
      const element = createMockElement();
      const ctx = createMockResponseContext(element);
      const error = new Error('Response error');

      let receivedError: Error | null = null;
      element.addEventListener('hype:response-error', (e) => {
        receivedError = (e as CustomEvent).detail.error;
      });

      events.dispatchResponseError(ctx, error);
      expect(receivedError).toBe(error);
    });
  });

  describe('debug mode', () => {
    it('should toggle debug mode', () => {
      events.setDebug(true);
      events.setDebug(false);
      // Just verify no errors
    });
  });
});
