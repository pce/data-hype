import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import createClient from "../src/client";

function mockFetchWithResponder(responder: (url: string, init?: any) => { body?: any; status?: number; ok?: boolean }) {
  const fn = vi.fn((url: string, init?: any) => {
    const r = responder(url, init) || {};
    const body = r.body === undefined ? {} : r.body;
    const status = typeof r.status === "number" ? r.status : 200;
    const ok = typeof r.ok === "boolean" ? r.ok : true;
    return Promise.resolve({
      ok,
      status,
      json: async () => body,
    });
  });
  // @ts-ignore
  global.fetch = fn;
  return fn;
}

describe("createClient (immutable factory)", () => {
  afterEach(() => {
    // @ts-ignore
    delete (global as any).fetch;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("default credentialMapper extracts username/password", async () => {
    const client = createClient();

    const form = document.createElement("form");
    form.className = "hype-login-form";

    const u = document.createElement("input");
    u.name = "username";
    u.value = "alice";
    form.appendChild(u);

    const p = document.createElement("input");
    p.name = "password";
    p.value = "s3cr3t";
    form.appendChild(p);

    document.body.appendChild(form);

    // extractCredentialsFromForm is async in the factory API
    const creds = await (client as any).extractCredentialsFromForm(form);
    expect(creds).toEqual({ username: "alice", password: "s3cr3t" });
  });

  it("supports async credentialMapper (passkey) and bindLoginForms uses loginWithPayload", async () => {
    const client = createClient({
      form: {
        credentialMapper: async (fd: FormData) => {
          // simulate async mapping (e.g. WebAuthn)
          await new Promise((r) => setTimeout(r, 0));
          return { token: String(fd.get("token") || "") };
        },
      },
    });

    const fetchMock = mockFetchWithResponder((url) => {
      if (url.endsWith("/csrf-token")) return { body: { ok: true, csrfToken: "tok" } };
      if (url.endsWith("/login")) return { body: { ok: true, user: { id: 2 } } };
      return { body: {} };
    });

    const form = document.createElement("form");
    form.className = "hype-login-form";
    const t = document.createElement("input");
    t.name = "token";
    t.value = "passkey-blob";
    form.appendChild(t);
    document.body.appendChild(form);

    const events: any[] = [];
    document.addEventListener("auth:login", (ev: any) => events.push(ev.detail));

    // bind and submit
    (client as any).bindLoginForm(document);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // wait for async handlers (network + mapper)
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalled();
    expect(events.length).toBe(1);
    expect(events[0]).toHaveProperty("user");
    expect(events[0].user).toEqual({ id: 2 });
  });

  it("default login path for username/password uses login and emits event", async () => {
    const client = createClient();

    const fetchMock = mockFetchWithResponder((url, init) => {
      if (url.endsWith("/csrf-token")) return { body: { ok: true, csrfToken: "tok" } };
      if (url.endsWith("/login")) {
        // Optionally inspect init.body here in more advanced tests
        return { body: { ok: true, user: { id: 3 } } };
      }
      return { body: {} };
    });

    const form = document.createElement("form");
    form.className = "hype-login-form";
    const u = document.createElement("input");
    u.name = "username";
    u.value = "bob";
    form.appendChild(u);
    const p = document.createElement("input");
    p.name = "password";
    p.value = "hunter2";
    form.appendChild(p);
    document.body.appendChild(form);

    const events: any[] = [];
    document.addEventListener("auth:login", (ev: any) => events.push(ev.detail));

    (client as any).bindLoginForm(document);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalled();
    expect(events.length).toBe(1);
    expect(events[0].user).toEqual({ id: 3 });
  });

  it("client.config is frozen (immutable)", () => {
    const client = createClient({ endpoints: { login: "/x" } });
    // config should be frozen (read-only)
    // @ts-ignore access frozen config
    expect(Object.isFrozen((client as any).config)).toBe(true);
    expect(Object.isFrozen((client as any).config.form)).toBe(true);
    expect(Object.isFrozen((client as any).config.form.fieldNames)).toBe(true);
  });
});
