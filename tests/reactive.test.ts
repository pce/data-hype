// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReactiveSystem, createReactive } from "../src/reactive";
import { Window } from "happy-dom";

describe("ReactiveSystem (named handlers + DSL JSON)", () => {
  let reactive: ReactiveSystem;
  let container: HTMLElement;

  beforeEach(() => {
    const window = new Window();
    const document = window.document;
    document.write("<!DOCTYPE html><html><body></body></html>");
    // set globals expected by ReactiveSystem tests
    // (happy-dom provides HTMLElement, Event, CustomEvent etc.)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    global.document = document;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    global.window = window;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    global.HTMLElement = window.HTMLElement;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    global.Event = window.Event;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
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

  describe("State Initialization", () => {
    it("should initialize state from data-hype-state attribute", () => {
      container.innerHTML = `
        <div id="component" data-hype-state='{ "count": 0, "open": false }'>
        </div>
      `;

      const component = document.getElementById("component") as HTMLElement;
      reactive.init(component);

      const state = reactive.getState(component);
      expect(state).toEqual({ count: 0, open: false });
    });

    it("should handle JSON state notation", () => {
      container.innerHTML = `
        <div data-hype-state='{ "name": "test", "value": 42 }'></div>
      `;

      const component = container.firstElementChild as HTMLElement;
      reactive.init(component);

      const state = reactive.getState(component);
      expect(state).toEqual({ name: "test", value: 42 });
    });

    it("should handle nested state objects", () => {
      container.innerHTML = `
        <div data-hype-state='{ "user": { "name": "John" }, "count": 0 }'></div>
      `;

      const component = container.firstElementChild as HTMLElement;
      reactive.init(component);

      const state = reactive.getState(component);
      expect(state).toEqual({ user: { name: "John" }, count: 0 });
    });

    it("should return null for elements without state", () => {
      container.innerHTML = `<div id="no-state"></div>`;

      const element = document.getElementById("no-state") as HTMLElement;
      reactive.init(container);

      const state = reactive.getState(element);
      expect(state).toBeNull();
    });
  });

  describe("Event Handlers (named handlers + DSL)", () => {
    it("should support DSL JSON set operation", () => {
      container.innerHTML = `
        <div data-hype-state='{ "clicked": false }'>
          <button data-hype-on-click='["set","clicked", true]'>Click</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();

      const state = reactive.getState(component);
      expect(state?.clicked).toBe(true);
    });

    it("should support DSL JSON toggle operation", () => {
      container.innerHTML = `
        <div data-hype-state='{ "open": false }'>
          <button data-hype-on-click='["toggle","open"]'>Toggle</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      expect(reactive.getState(component)?.open).toBe(true);

      button.click();
      expect(reactive.getState(component)?.open).toBe(false);
    });

    it("should support DSL JSON arithmetic set", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 0 }'>
          <button data-hype-on-click='["set","count", ["+", ["get","count"], 1]]'>Increment</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      expect(reactive.getState(component)?.count).toBe(1);

      button.click();
      expect(reactive.getState(component)?.count).toBe(2);
    });

    it("should support sequence of DSL statements", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 0, "clicked": false }'>
          <button data-hype-on-click='["seq", ["set","count", ["+", ["get","count"], 1]], ["toggle","clicked"]]'>Click</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      const state = reactive.getState(component);
      expect(state?.count).toBe(1);
      expect(state?.clicked).toBe(true);
    });

    it("should provide $event in DSL context", () => {
      container.innerHTML = `
        <div data-hype-state='{ "value": "" }'>
          <input data-hype-on-input='["set","value", ["get","$event.target.value"]]' />
        </div>
      `;

      reactive.init(container);
      const input = container.querySelector("input") as HTMLInputElement;
      const component = container.firstElementChild as HTMLElement;

      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      const state = reactive.getState(component);
      expect(state?.value).toBe("test");
    });

    it("should provide $el reference via DSL hasClass", () => {
      container.innerHTML = `
        <div data-hype-state='{ "hasClass": false }'>
          <button class="test-class" data-hype-on-click='["set","hasClass", ["hasClass","test-class"]]'>
            Check
          </button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      expect(reactive.getState(component)?.hasClass).toBe(true);
    });

    it("should support named handler registration and state-path mapping", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 0 }'>
          <button data-hype-on-click="incCount" data-hype-rx="count">Inc</button>
        </div>
      `;

      reactive.init(container);
      // register handler after init (handlers are looked up at invocation time)
      reactive.registerHandler("incCount", (current) => {
        return (typeof current === "number" ? current : 0) + 1;
      });

      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      button.click();

      expect(reactive.getState(component)?.count).toBe(2);
    });

    it("should support async named handlers", async () => {
      container.innerHTML = `
        <div data-hype-state='{ "value": 1 }'>
          <button data-hype-on-click="double" data-hype-rx="value">Double</button>
        </div>
      `;

      reactive.init(container);
      reactive.registerHandler("double", async (current) => {
        // simulate async update
        return new Promise((resolve) => setTimeout(() => resolve((current || 0) * 2), 0));
      });

      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      // wait a microtask to allow promise resolution
      await new Promise((r) => setTimeout(r, 10));

      expect(reactive.getState(component)?.value).toBe(2);
    });
  });

  describe("Conditional Visibility (data-hype-show)", () => {
    it("should show element when expression is truthy (path)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "visible": true }'>
          <p data-hype-show="visible">Content</p>
        </div>
      `;

      reactive.init(container);
      const paragraph = container.querySelector("p") as HTMLElement;

      expect(paragraph.style.display).not.toBe("none");
      expect(paragraph.hasAttribute("hidden")).toBe(false);
    });

    it("should hide element when expression is falsy (path)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "visible": false }'>
          <p data-hype-show="visible">Content</p>
        </div>
      `;

      reactive.init(container);
      const paragraph = container.querySelector("p") as HTMLElement;

      expect(paragraph.style.display).toBe("none");
      expect(paragraph.hasAttribute("hidden")).toBe(true);
    });

    it("should reactively update visibility (toggle via DSL)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "visible": false }'>
          <button data-hype-on-click='["toggle","visible"]'>Toggle</button>
          <p data-hype-show="visible">Content</p>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const paragraph = container.querySelector("p") as HTMLElement;

      expect(paragraph.style.display).toBe("none");

      button.click();
      expect(paragraph.style.display).not.toBe("none");

      button.click();
      expect(paragraph.style.display).toBe("none");
    });

    it("should support comparison via DSL", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 5 }'>
          <p data-hype-show='[">", ["get","count"], 0]'>Has items</p>
        </div>
      `;

      reactive.init(container);
      const paragraph = container.querySelector("p") as HTMLElement;

      expect(paragraph.style.display).not.toBe("none");
    });

    it("should support negation via DSL", () => {
      container.innerHTML = `
        <div data-hype-state='{ "loading": true }'>
          <p data-hype-show='["!", ["get","loading"]]'>Ready</p>
        </div>
      `;

      reactive.init(container);
      const paragraph = container.querySelector("p") as HTMLElement;

      expect(paragraph.style.display).toBe("none");
    });
  });

  describe("Conditional Classes & Attribute Binding", () => {
    it("should add/remove classes based on simple path", () => {
      container.innerHTML = `
        <div data-hype-state='{ "active": true }'>
          <button data-hype-class-active="active">Button</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLElement;
      expect(button.classList.contains("active")).toBe(true);
    });

    it("should reactively update classes when toggled (DSL)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "selected": false }'>
          <button data-hype-on-click='["toggle","selected"]' data-hype-class-selected="selected">Button</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLElement;
      expect(button.classList.contains("selected")).toBe(false);

      button.click();
      expect(button.classList.contains("selected")).toBe(true);
    });

    it("should bind attributes (path)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "url": "https://example.com" }'>
          <a data-hype-bind-href="url">Link</a>
        </div>
      `;

      reactive.init(container);
      const link = container.querySelector("a") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("https://example.com");
    });

    it("should bind boolean attributes reactively (DSL toggle)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "loading": false }'>
          <button data-hype-on-click='["toggle","loading"]' data-hype-bind-disabled="loading">Submit</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      expect(button.hasAttribute("disabled")).toBe(false);

      button.click();
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("should bind data attributes", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 42 }'>
          <span data-hype-bind-data-count="count">0</span>
        </div>
      `;

      reactive.init(container);
      const span = container.querySelector("span") as HTMLElement;
      expect(span.getAttribute("data-count")).toBe("42");
    });
  });

  describe("State Scope & API", () => {
    it("should find parent state context and use DSL increment", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 0 }'>
          <div>
            <button data-hype-on-click='["set","count", ["+", ["get","count"], 1]]'>Increment</button>
          </div>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      button.click();
      expect(reactive.getState(component)?.count).toBe(1);
    });

    it("should create new scope for nested state", () => {
      container.innerHTML = `
        <div id="outer" data-hype-state='{ "outer": true }'>
          <div id="inner" data-hype-state='{ "inner": true }'>
            <p>Content</p>
          </div>
        </div>
      `;

      reactive.init(container);
      const outer = document.getElementById("outer") as HTMLElement;
      const inner = document.getElementById("inner") as HTMLElement;

      const outerState = reactive.getState(outer);
      const innerState = reactive.getState(inner);

      expect(outerState).toEqual({ outer: true });
      expect(innerState).toEqual({ inner: true });
      expect(outerState).not.toBe(innerState);
    });

    it("should update state via setState()", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 0 }'>
          <p data-hype-show='[">", ["get","count"], 0]'>Visible</p>
        </div>
      `;

      reactive.init(container);
      const component = container.firstElementChild as HTMLElement;
      const paragraph = container.querySelector("p") as HTMLElement;

      expect(paragraph.style.display).toBe("none");

      reactive.setState(component, { count: 5 });
      expect(paragraph.style.display).not.toBe("none");
    });

    it("should merge state updates", () => {
      container.innerHTML = `
        <div data-hype-state='{ "a": 1, "b": 2 }'></div>
      `;

      reactive.init(container);
      const component = container.firstElementChild as HTMLElement;

      reactive.setState(component, { b: 3, c: 4 });

      const state = reactive.getState(component);
      expect(state).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("should destroy state on destroy()", () => {
      container.innerHTML = `
        <div data-hype-state='{ "value": 42 }'></div>
      `;

      reactive.init(container);
      const component = container.firstElementChild as HTMLElement;

      expect(reactive.getState(component)).toBeTruthy();

      reactive.destroy(component);
      expect(reactive.getState(component)).toBeNull();
    });
  });

  describe("Edge Cases (adapted)", () => {
    it("should handle invalid state JSON gracefully", () => {
      container.innerHTML = `
        <div data-hype-state='invalid json'></div>
      `;

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      reactive.init(container);
      const component = container.firstElementChild as HTMLElement;

      expect(reactive.getState(component)).toBeNull();
      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });

    it("should report invalid DSL JSON expressions", () => {
      container.innerHTML = `
        <div data-hype-state='{ "value": 0 }'>
          <button data-hype-on-click='["set","value", ]'>Click</button>
        </div>
      `;

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;

      button.click();

      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("should handle elements with no state context", () => {
      container.innerHTML = `
        <div>
          <button data-hype-on-click='["set","missing", 1]'>Click</button>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;

      // Should not throw
      expect(() => button.click()).not.toThrow();
    });

    it("should handle rapid state changes (DSL increment)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "count": 0 }'>
          <button data-hype-on-click='["set","count", ["+", ["get","count"], 1]]'>+</button>
          <p data-hype-bind-data-count="count">0</p>
        </div>
      `;

      reactive.init(container);
      const button = container.querySelector("button") as HTMLButtonElement;
      const paragraph = container.querySelector("p") as HTMLElement;
      const component = container.firstElementChild as HTMLElement;

      // Rapid clicks
      for (let i = 0; i < 10; i++) {
        button.click();
      }

      expect(reactive.getState(component)?.count).toBe(10);
      expect(paragraph.getAttribute("data-count")).toBe("10");
    });
  });

  describe("Integration with Hype (named handler for $fetch-like behavior)", () => {
    it("should trigger an application handler that dispatches a click (simulate $fetch)", () => {
      container.innerHTML = `
        <div data-hype-state='{ "clicked": false }'>
          <button id="submit" data-hype-on-click="submitAction" data-hype-rx="clicked">Submit</button>
        </div>
      `;

      reactive.init(container);
      // register a handler that toggles state and dispatches a click to simulate $fetch
      reactive.registerHandler("submitAction", (current, { element }) => {
        // toggle clicked
        const next = !(typeof current === "boolean" ? current : false);
        // dispatch a click event so tests can observe side effects
        try {
          const btn = element as HTMLElement;
          btn.dispatchEvent(new Event("click", { bubbles: true }));
        } catch {
          /* ignore */
        }
        return next;
      });

      const button = container.querySelector("#submit") as HTMLButtonElement;
      const component = container.firstElementChild as HTMLElement;

      let clickFired = false;
      button.addEventListener("click", () => {
        clickFired = true;
      });

      button.click();

      // state toggled and click handler triggered
      expect(reactive.getState(component)?.clicked).toBe(true);
      expect(clickFired).toBe(true);
    });
  });

  describe("Factory Function", () => {
    it("should create reactive instance with createReactive()", () => {
      const instance = createReactive({ debug: false });
      expect(instance).toBeInstanceOf(ReactiveSystem);
    });

    it("should pass config to constructor", () => {
      const instance = createReactive({
        debug: true,
        attributePrefix: "custom",
      });

      expect(instance).toBeInstanceOf(ReactiveSystem);
      expect(instance.getConfig).toBeDefined;
    });
  });
});
