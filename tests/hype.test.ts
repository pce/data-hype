import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hype, createHype } from "../src/hype";
import type { HypeConfig } from "../src/types";

describe("Hype", () => {
  let hype: Hype;

  beforeEach(() => {
    hype = createHype({ debug: false });
  });

  afterEach(() => {
    hype.destroy();
    document.body.innerHTML = "";
  });

  describe("constructor", () => {
    it("should create instance with default config (innerHTML opt-in)", () => {
      // Opt-in to innerHTML for this test to avoid changing the safer default in code.
      const instance = new Hype({ defaultSwap: "innerHTML" });
      expect(instance).toBeInstanceOf(Hype);
      expect(instance.getConfig().defaultSwap).toBe("innerHTML");
      expect(instance.getConfig().timeout).toBe(30000);
    });

    it("should merge custom config", () => {
      const config: Partial<HypeConfig> = {
        defaultSwap: "outerHTML",
        timeout: 5000,
        debug: true,
      };
      const instance = new Hype(config);
      expect(instance.getConfig().defaultSwap).toBe("outerHTML");
      expect(instance.getConfig().timeout).toBe(5000);
      expect(instance.getConfig().debug).toBe(true);
    });
  });

  describe("init and destroy", () => {
    it("should initialize without error", () => {
      expect(() => hype.init()).not.toThrow();
    });

    it("should not initialize twice", () => {
      hype.init();
      expect(() => hype.init()).not.toThrow();
    });

    it("should destroy without error", () => {
      hype.init();
      expect(() => hype.destroy()).not.toThrow();
    });

    it("should handle destroy before init", () => {
      expect(() => hype.destroy()).not.toThrow();
    });
  });

  describe("configure", () => {
    it("should update configuration", () => {
      hype.configure({ debug: true, timeout: 10000 });
      expect(hype.getConfig().debug).toBe(true);
      expect(hype.getConfig().timeout).toBe(10000);
    });
  });

  describe("interceptors", () => {
    it("should register and unregister request interceptor", () => {
      const interceptor = vi.fn();
      const unregister = hype.onRequest(interceptor);
      expect(typeof unregister).toBe("function");
      unregister();
    });

    it("should register and unregister response interceptor", () => {
      const interceptor = vi.fn();
      const unregister = hype.onResponse(interceptor);
      expect(typeof unregister).toBe("function");
      unregister();
    });

    it("should register and unregister swap handler", () => {
      const handler = vi.fn();
      const unregister = hype.registerSwap("custom", handler);
      expect(typeof unregister).toBe("function");
      unregister();
    });

    it("should register and unregister validator", () => {
      const validator = vi.fn();
      const unregister = hype.registerValidator("custom", validator);
      expect(typeof unregister).toBe("function");
      unregister();
    });
  });
});

describe("createHype", () => {
  it("should create a new Hype instance", () => {
    const instance = createHype();
    expect(instance).toBeInstanceOf(Hype);
  });

  it("should accept configuration", () => {
    const instance = createHype({ debug: true });
    expect(instance.getConfig().debug).toBe(true);
  });
});
