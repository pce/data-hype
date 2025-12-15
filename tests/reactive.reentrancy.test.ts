import { describe, it, expect } from 'vitest';
import { createReactive } from '../src/reactive';

describe('Reactive reentrancy regression', () => {
  it('should not cause stack overflow when watcher mutates state synchronously', () => {
    const reactive = createReactive({ debug: false });
    // Component markup: state + button wired to named handler via data-hype-on-click
    document.body.innerHTML = `
      <div id="comp" data-hype-state='{"count":0}'>
        <button id="btn" data-hype-on-click="incSync" data-hype-rx="count">inc</button>
        <span id="out" data-hype-bind-data-count="count"></span>
      </div>
    `;
    const comp = document.getElementById('comp') as HTMLElement;
    const btn = document.getElementById('btn') as HTMLElement;
    const out = document.getElementById('out') as HTMLElement;

    // Register a named handler that synchronously returns the next value.
    // The reactive system will run this handler and write the returned value
    // to the state path specified on the invoking element (data-hype-rx="count").
    reactive.registerHandler('incSync', (current) => {
      // synchronous increment that used to cause re-entrancy issues
      return (current || 0) + 1;
    });

    // Initialize the reactive system on the component (attaches event listeners etc.)
    reactive.init(comp);

    // Click the button multiple times synchronously. Previously this could trigger
    // deep re-entrancy / stack growth; after fixes it should complete safely.
    for (let i = 0; i < 10; i += 1) {
      btn.click();
    }

    // Verify state updated and the DOM binding was applied.
    expect(reactive.getState(comp)?.count).toBe(10);
    expect(out.getAttribute('data-count')).toBe('10');
  });
});