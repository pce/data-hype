import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHype } from "../src/hype";

describe("Hype teardown (unmount / destroy)", () => {
  beforeEach(() => {
    // Ensure clean DOM before each test
    document.body.innerHTML = "";
    try {
      // clear any global reference that previous tests may have set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).hype) delete (window as any).hype;
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    // extra cleanup guard
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).hype && typeof (window as any).hype.destroy === "function") {
        // attempt teardown in case a test left it initialized
        try {
          (window as any).hype.destroy();
        } catch {
          /* ignore */
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).hype) delete (window as any).hype;
    } catch {
      /* ignore */
    }
    document.body.innerHTML = "";
  });

  it("unmount() allows remounting: mount -> unmount -> mount again", () => {
    const root = document.createElement("div");
    root.id = "test-root";
    document.body.appendChild(root);

    // create instance without auto-init
    const hype = createHype({}, false as any);

    // initial mount should succeed
    expect(() => hype.mount("#test-root")).not.toThrow();

    // second mount attempt without unmount should throw
    expect(() => hype.mount("#test-root")).toThrow();

    // unmount should allow mounting again
    expect(() => hype.unmount()).not.toThrow();
    expect(() => hype.mount("#test-root")).not.toThrow();

    // cleanup
    try {
      hype.unmount();
    } catch {
      /* ignore */
    }
  });

  it("destroy() calls plugin cleanup functions and is idempotent", () => {
    const cleanup = vi.fn();
    // plugin function returns a cleanup function
    function plugin() {
      return cleanup;
    }

    const hype = createHype({}, false as any);

    // attach the plugin; attach() calls plugin synchronously
    hype.attach(plugin);

    // init so that destroy path is exercised as in normal usage
    expect(() => hype.init()).not.toThrow();

    // destroy should call the cleanup function
    expect(cleanup).not.toHaveBeenCalled();
    expect(() => hype.destroy()).not.toThrow();
    expect(cleanup).toHaveBeenCalled();

    // calling destroy again must not throw and should be safe (idempotent)
    expect(() => hype.destroy()).not.toThrow();
  });

  it("init publishes window.hype and destroy removes the global reference", () => {
    const hype = createHype({}, false as any);

    // Before init the global may not be set
    // init should set a global window.hype reference to the instance
    expect(() => hype.init()).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const globalRef = (window as any).hype;
    expect(globalRef).toBeTruthy();
    // global must reference our instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).hype).toBe(hype);

    // destroy should remove or unset the global reference if it points to this instance
    expect(() => hype.destroy()).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).hype === hype) {
      // If destroy didn't delete the property due to environment quirks, attempt strict check
      expect((window as any).hype).not.toBe(hype);
    } else {
      // Either removed or replaced; simply assert it's not the same instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).hype).not.toBe(hype);
    }

    // cleanup any leftover global
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).hype) delete (window as any).hype;
    } catch {
      /* ignore */
    }
  });
});