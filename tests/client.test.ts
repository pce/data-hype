import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import createClient, { defaultClient } from "../src/client";

describe("client helpers", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  // Use the default immutable client instance
  const client = defaultClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    // @ts-ignore - assign to global.fetch for the test environment
    global.fetch = mockFetch;
  });

  afterEach(() => {
    mockFetch.mockReset();
    // @ts-ignore
    delete (global as any).fetch;
  });

  describe("fetchJson", () => {
    it("parses JSON responses and returns body with status and ok", async () => {
      const payload = { ok: true, foo: "bar" };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.fetchJson("/test-endpoint");
      expect(result).toHaveProperty("status", 200);
      expect(result).toHaveProperty("ok", true);
      // payload properties are merged through
      // @ts-ignore
      expect(result.foo).toBe("bar");
    });

    it("handles invalid JSON gracefully and returns ok: false with status", async () => {
      // server returns invalid JSON (but content-type json)
      mockFetch.mockResolvedValueOnce(
        new Response("not-json", {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.fetchJson("/bad-json");
      expect(result).toHaveProperty("status", 500);
      expect(result).toHaveProperty("ok", false);
    });

    it("returns ok:false and error when fetch rejects", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network failure"));

      const result = await client.fetchJson("/network-error");
      expect(result).toHaveProperty("ok", false);
      expect(typeof (result as any).error).toBe("string");
      expect((result as any).error).toMatch(/network failure/);
    });
  });

  describe("getCsrfToken", () => {
    it("returns token string when endpoint responds with ok and csrfToken", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, csrfToken: "abc123" }), { status: 200 }));

      const token = await client.getCsrfToken("/csrf-token");
      expect(token).toBe("abc123");
    });

    it("returns null when endpoint responds ok:false", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 403 }));

      const token = await client.getCsrfToken("/csrf-token");
      expect(token).toBeNull();
    });

    it("returns null when response contains invalid JSON", async () => {
      mockFetch.mockResolvedValueOnce(new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }));

      const token = await client.getCsrfToken("/csrf-token");
      expect(token).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      const token = await client.getCsrfToken("/csrf-token");
      expect(token).toBeNull();
    });
  });
});
