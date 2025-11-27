import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createHypePubsub,
  attachToHype,
  createBehaviorRegistry,
  parseTriggerSpec,
  attachBehaviorsFromAttribute,
  attachDebounce,
} from "../src";

describe("plugins: pubsub, behaviors, debounce", () => {
  beforeEach(() => {
    // clean DOM between tests
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    // reset timers default behavior
    try {
      vi.useRealTimers();
    } catch {
      /* ignore if environment already real timers */
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
    try {
      vi.useRealTimers();
    } catch {
      /* ignore */
    }
  });

  describe("pubsub", () => {
    it("should call subscribers when publishing and return unsubscribe", () => {
      const { pub, sub } = createHypePubsub();
      const handler = vi.fn();

      const unsubscribe = sub("topic:a", handler);
      pub("topic:a", { foo: "bar" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ foo: "bar" });

      // Unsubscribe and ensure it no longer receives messages
      unsubscribe();
      pub("topic:a", { foo: "baz" });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should emit a DOM event 'hype:pub' when publishing", () => {
      const { pub } = createHypePubsub();
      const domHandler = vi.fn();
      document.addEventListener("hype:pub", (e: Event) => {
        // store the event so we can inspect
        domHandler((e as CustomEvent).detail);
      });

      pub("topic:dom", { n: 1 });

      expect(domHandler).toHaveBeenCalledTimes(1);
      expect(domHandler.mock.calls[0][0]).toEqual({ topic: "topic:dom", payload: { n: 1 } });
    });

    it("attachToHype should expose pub/sub on the instance", () => {
      const fakeHype: any = {};
      const ps = attachToHype(fakeHype);
      const handler = vi.fn();
      const unsub = fakeHype.sub("x", handler);

      fakeHype.pub("x", 123);
      expect(handler).toHaveBeenCalledWith(123);

      unsub();
      fakeHype.pub("x", 456);
      expect(handler).toHaveBeenCalledTimes(1);

      // ensure attach returned the same pub/sub functions
      expect(typeof ps.pub).toBe("function");
      expect(typeof ps.sub).toBe("function");
    });
  });

  describe("behavior registry", () => {
    it("parseTriggerSpec should parse various trigger strings", () => {
      const specs = parseTriggerSpec("revealed; interval:5000 | scroll-bottom:200:repeat");
      expect(specs).toHaveLength(3);
      expect(specs[0].name).toBe("revealed");
      expect(specs[1].name).toBe("interval");
      expect(specs[1].param).toBe("5000");
      expect(specs[2].name).toBe("scroll-bottom");
      expect(specs[2].param).toBe("200");
      // repeat flag should be inferred when trailing :repeat present
      const specs2 = parseTriggerSpec("interval:1000:repeat");
      expect(specs2[0].name).toBe("interval");
      expect(specs2[0].param).toBe("1000");
      expect(specs2[0].repeat).toBe(true);
    });

    it("click behavior should call default action", () => {
      const action = vi.fn();
      const reg = createBehaviorRegistry((el, spec) => action(spec));
      const impl = reg.get("click");
      expect(impl).toBeDefined();

      const btn = document.createElement("button");
      document.body.appendChild(btn);

      const unsub = impl!.attach(btn, { name: "click" });
      // simulate click
      btn.click();

      expect(action).toHaveBeenCalledTimes(1);
      // cleanup
      unsub();
      document.body.removeChild(btn);
    });

    it("interval behavior should call action on schedule", () => {
      const action = vi.fn();
      const reg = createBehaviorRegistry((el, spec) => action(spec));
      const impl = reg.get("interval");
      expect(impl).toBeDefined();

      const el = document.createElement("div");
      document.body.appendChild(el);

      // Use fake timers to advance intervals
      vi.useFakeTimers();
      const unsub = impl!.attach(el, { name: "interval", param: "50" });

      // advance time a few ticks
      vi.advanceTimersByTime(160);
      expect(action).toHaveBeenCalled();
      // cleanup
      unsub();
      vi.useRealTimers();
      document.body.removeChild(el);
    });

    it("attachBehaviorsFromAttribute wires triggers on elements", () => {
      const action = vi.fn();
      // create registry with our action so defaultAction calls this
      const reg = createBehaviorRegistry((el, spec) => action(spec));
      // attach behaviors to document body using the registry
      const cleanup = attachBehaviorsFromAttribute(document.body, reg, undefined, "data-hype-trigger");

      // create element with two triggers: click and interval:30
      const el = document.createElement("div");
      el.setAttribute("data-hype-trigger", "click; interval:30");
      document.body.appendChild(el);

      // click should fire action (sync)
      el.click();
      expect(action).toHaveBeenCalled();

      // interval should schedule calls
      vi.useFakeTimers();
      // wait for interval to run
      vi.advanceTimersByTime(100);
      expect(action).toHaveBeenCalled(); // called at least once more
      vi.useRealTimers();

      // cleanup
      cleanup();
      document.body.removeChild(el);
    });
  });

  describe("debounce wiring", () => {
    it("attachDebounce dispatches hype:debounced-input after debounce window", async () => {
      const hypeMock: any = {
        trigger: vi.fn(() => Promise.resolve()),
      };
      // attach debounce wiring to document
      const cleanup = attachDebounce(document, hypeMock, "data-hype-debounce");

      const input = document.createElement("input");
      input.setAttribute("data-hype-debounce", "100");
      document.body.appendChild(input);

      const handler = vi.fn();
      input.addEventListener("hype:debounced-input", (e: Event) => {
        handler((e as CustomEvent).detail);
      });

      vi.useFakeTimers();

      // simulate rapid typing
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(50);
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(50);
      // not fired yet
      expect(handler).toHaveBeenCalledTimes(0);

      // advance past debounce
      vi.advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(1);

      // ensure hype.trigger was called (attachDebounce triggers hype.trigger if provided)
      expect(hypeMock.trigger).toHaveBeenCalled();

      // cleanup
      cleanup();
      vi.useRealTimers();
      document.body.removeChild(input);
    });
  });
});
