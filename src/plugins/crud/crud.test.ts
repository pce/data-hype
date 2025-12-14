// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import createCrudPlugin from "./index";

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

type AnyObj = Record<string, any>;

/**
 * Helper to capture document-level CustomEvents emitted by the plugin.
 * Records tuples of [eventName, detail]
 */
function captureDocumentEvents() {
  const events: Array<{ name: string; detail: any }> = [];
  const handler = (ev: Event) => {
    try {
      const ce = ev as CustomEvent;
      events.push({ name: (ev as CustomEvent).type, detail: ce.detail });
    } catch {
      // ignore
    }
  };

  const listen = (name: string) => {
    document.addEventListener(name, handler as EventListener);
  };

  const stop = () => {
    try {
      // remove all known CRUD events we might have listened for
      const names = [
        "crud:before:list",
        "crud:after:list",
        "crud:before:get",
        "crud:after:get",
        "crud:before:create",
        "crud:after:create",
        "crud:item:created",
        "crud:before:update",
        "crud:after:update",
        "crud:item:updated",
        "crud:before:delete",
        "crud:after:delete",
        "crud:item:deleted",
        "crud:error",
      ];
      for (const n of names) document.removeEventListener(n, handler as EventListener);
    } catch {
      // ignore
    }
  };

  // Pre-wire common CRUD events so we capture in-order reception
  [
    "crud:before:list",
    "crud:after:list",
    "crud:before:get",
    "crud:after:get",
    "crud:before:create",
    "crud:after:create",
    "crud:item:created",
    "crud:before:update",
    "crud:after:update",
    "crud:item:updated",
    "crud:before:delete",
    "crud:after:delete",
    "crud:item:deleted",
    "crud:error",
  ].forEach(listen);

  return { events, stop };
}

describe("CRUD plugin - core behaviors", () => {
  beforeEach(() => {
    // ensure no leftover listeners/data
  });

  afterEach(() => {
    // cleanup DOM listeners if any remain (tests call stop themselves)
  });

  it("dedupes concurrent list requests (single adapter.list call)", async () => {
    const calls: AnyObj[] = [];
    const adapter = {
      list: vi.fn(async (params?: AnyObj) => {
        calls.push({ params });
        // simulate network latency
        await delay(40);
        return { items: [{ id: 1, title: "one" }], total: 1 };
      }),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const hypeInstance: any = {
      getConfig: () => ({ attributePrefix: "hype" }),
      emit: vi.fn(),
      events: { dispatch: vi.fn() },
      pub: vi.fn(),
    };

    const plugin = createCrudPlugin({ adapter: adapter as any, resource: "items" });
    const cleanup = plugin.install(hypeInstance);

    // call list twice concurrently
    const p1 = hypeInstance.crud.list("items");
    const p2 = hypeInstance.crud.list("items");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(adapter.list).toHaveBeenCalledTimes(1);
    expect(Array.isArray(r1.items)).toBe(true);
    expect(r1.items.length).toBe(1);
    expect(r2.items.length).toBe(1);

    // ensure subsequent separate call will invoke adapter again
    const r3 = await hypeInstance.crud.list("items");
    expect(adapter.list).toHaveBeenCalledTimes(2);

    // cleanup plugin
    try {
      cleanup && cleanup();
    } catch {}
  });

  it("emits optimistic create then rolls back on adapter failure (optimistic create rollback)", async () => {
    // Adapter that rejects create
    const adapter = {
      list: vi.fn(async () => ({ items: [] as any[] })),
      get: vi.fn(),
      create: vi.fn(async (_payload: AnyObj) => {
        // wait a tick to ensure optimistic event emitted
        await delay(20);
        const err: any = new Error("create-failed");
        err.status = 500;
        throw err;
      }),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const hypeInstance: any = {
      getConfig: () => ({ attributePrefix: "hype" }),
      emit: vi.fn(),
      events: { dispatch: vi.fn() },
      pub: vi.fn(),
    };

    const plugin = createCrudPlugin({ adapter: adapter as any, resource: "items" });
    const cleanup = plugin.install(hypeInstance);

    const captured = captureDocumentEvents();

    // Attempt optimistic create (should throw)
    let thrown: any = null;
    try {
      await hypeInstance.crud.create("items", { title: "temp" }, { optimistic: true });
    } catch (err) {
      thrown = err;
    }

    // Wait briefly to allow error event to propagate
    await delay(30);

    // stop capturing and inspect
    captured.stop();

    // Ensure adapter.create was invoked
    expect(adapter.create).toHaveBeenCalledTimes(1);
    // Check that an error was thrown by public API
    expect(thrown).toBeTruthy();

    // Ensure we observed the event sequence: before:create -> item:created (optimistic) -> crud:error
    const names = captured.events.map((e) => e.name);
    // Must contain before create
    expect(names.indexOf("crud:before:create")).toBeGreaterThanOrEqual(0);
    // Must contain optimistic created event
    const createdEvents = captured.events.filter((e) => e.name === "crud:item:created");
    expect(createdEvents.length).toBeGreaterThanOrEqual(1);
    // optimistic flag should be true on the optimistic creation
    const optimisticEvent = createdEvents.find((ce) => ce.detail && ce.detail.optimistic === true);
    expect(optimisticEvent).toBeTruthy();

    // Ensure error event fired
    const errEv = captured.events.find((e) => e.name === "crud:error");
    expect(errEv).toBeTruthy();

    // Ensure we did NOT receive a second non-optimistic 'crud:item:created' (i.e. no commit)
    const nonOptimistic = createdEvents.find((ce) => ce.detail && !ce.detail.optimistic);
    expect(nonOptimistic).toBeUndefined();

    try {
      cleanup && cleanup();
    } catch {}
  });

  it("emits proper before/create events for non-optimistic creates (event sequence)", async () => {
    const adapter = {
      list: vi.fn(async () => ({ items: [] as any[] })),
      get: vi.fn(),
      create: vi.fn(async (payload: AnyObj) => {
        await delay(10);
        // simulate server assigned id
        return { ...payload, id: "server-123" };
      }),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const hypeInstance: any = {
      getConfig: () => ({ attributePrefix: "hype" }),
      emit: vi.fn(),
      events: { dispatch: vi.fn() },
      pub: vi.fn(),
    };

    const plugin = createCrudPlugin({ adapter: adapter as any, resource: "items" });
    const cleanup = plugin.install(hypeInstance);

    const captured = captureDocumentEvents();

    const item = await hypeInstance.crud.create("items", { title: "real" });

    // Wait briefly to allow events to reach document
    await delay(20);
    captured.stop();

    // Assertions
    expect(item && (item as any).id).toBe("server-123");

    const names = captured.events.map((e) => e.name);
    const beforeIdx = names.indexOf("crud:before:create");
    const itemCreatedIdx = names.indexOf("crud:item:created");

    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(itemCreatedIdx).toBeGreaterThanOrEqual(0);
    // before:create should come before item:created
    expect(beforeIdx).toBeLessThan(itemCreatedIdx);

    // verify the created event detail contains the returned item
    const createdEvent = captured.events.find((e) => e.name === "crud:item:created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent!.detail && createdEvent!.detail.item && createdEvent!.detail.item.id === "server-123").toBeTruthy();

    try {
      cleanup && cleanup();
    } catch {}
  });
});
