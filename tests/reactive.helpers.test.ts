// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReactiveSystem } from "../src/reactive";
import { Window } from "happy-dom";

describe("ReactiveSystem helpers: watch() and flush()", () => {
  let reactive: ReactiveSystem;
  let container: HTMLElement;

  beforeEach(() => {
    const window = new Window();
    const document = window.document;
    document.write("<!DOCTYPE html><html><body></body></html>");
    // Provide globals expected by ReactiveSystem
    // @ts-ignore
    global.document = document;
    // @ts-ignore
    global.window = window;
    // @ts-ignore
    global.HTMLElement = window.HTMLElement;
    // @ts-ignore
    global.Event = window.Event;
    // @ts-ignore
    global.CustomEvent = window.CustomEvent;

    reactive = new ReactiveSystem({ debug: false });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    // cleanup DOM
    document.body.innerHTML = "";
  });

  it("watch() registers a watcher that runs when state changes and flush() forces notifications", () => {
    container.innerHTML = `<div data-hype-state='{ "count": 0 }'></div>`;
    const component = container.firstElementChild as HTMLElement;
    reactive.init(component);

    const state = reactive.getState(component);
    expect(state).toBeTruthy();

    const spy = vi.fn();
    const unsubscribe = reactive.watch(component, spy);

    // synchronous state change schedules a microtask; watcher should not have run yet
    state.count = 1;
    expect(spy).not.toHaveBeenCalled();

    // force immediate flush -> watcher should run once
    reactive.flush(component);
    expect(spy).toHaveBeenCalledTimes(1);

    // unsubscribe and change state again; watcher should not be called anymore
    unsubscribe();
    state.count = 2;
    reactive.flush(component);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("multiple rapid state changes coalesce into a single watcher invocation on flush()", () => {
    container.innerHTML = `<div data-hype-state='{ "count": 0 }'><p data-hype-bind-data-count="count"></p></div>`;
    const component = container.firstElementChild as HTMLElement;
    reactive.init(component);

    const state = reactive.getState(component);
    expect(state).toBeTruthy();

    const spy = vi.fn();
    reactive.watch(component, spy);

    // rapid synchronous updates
    for (let i = 0; i < 5; i++) {
      state.count = state.count + 1;
    }

    // still in same tick: watcher shouldn't have run yet
    expect(spy).not.toHaveBeenCalled();

    // one flush must run watcher exactly once (coalesced)
    reactive.flush(component);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("watch() on an element with no reactive context returns a no-op unsubscribe and does not throw", () => {
    const orphan = document.createElement("div");
    const spy = vi.fn();
    // Should not throw and should return an unsubscribe function
    const unsub = reactive.watch(orphan as HTMLElement, spy);
    expect(typeof unsub).toBe("function");

    // calling unsubscribe should be safe
    expect(() => unsub()).not.toThrow();
    // flushing a non-reactive element is safe
    expect(() => reactive.flush(orphan as HTMLElement)).not.toThrow();
  });

  it("flush() is safe when there is no pending notification or no context", () => {
    const el = document.createElement("div");
    // nothing initialized for el; flush should be a safe no-op
    expect(() => reactive.flush(el as HTMLElement)).not.toThrow();

    // even after init of unrelated component flushing another element should be safe
    container.innerHTML = `<div data-hype-state='{ "a": 1 }'></div>`;
    const component = container.firstElementChild as HTMLElement;
    reactive.init(component);
    expect(() => reactive.flush(document.createElement("div"))).not.toThrow();
  });
});
