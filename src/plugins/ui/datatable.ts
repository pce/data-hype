/**
 * src/plugins/ui/datatable.ts
 *
 * KISS datatable plugin for Hype CRUD resources.
 *
 * - Minimal, markup-first.
 * - Scans for elements with `data-{prefix}-crud="resource"` (prefix defaults to `hype`).
 * - Prefers `hype.crud` API when available; falls back to a `data-{prefix}-crud-endpoint` fetch.
 * - Renders rows using a template selector `data-{prefix}-crud-template` (defaults to `#item-row-tpl`).
 * - Wires simple actions by convention:
 *     - [data-action="create"]  -> create (form or prompt)
 *     - [data-action="edit"]    -> edit (form or prompt)
 *     - [data-action="delete"]  -> delete (confirm)
 *     - [data-action="toggle"]  -> toggle (calls /:id/toggle or updates via crud.update)
 *
 * Implementation goals:
 * - Keep small and secure: prefer DOM APIs and `hype.templateClone` when available.
 * - Avoid fragile string regex escapes for HTML; when interpolation is necessary
 *   use template cloning + textContent / setAttribute paths.
 */

import type { ListParams } from "../crud/adapter.interface";
import { serializeForm, prepareRequestBody } from "../../form";

type HypeLike = any;

export function createDataTablePlugin(opts: { selector?: string } = {}) {
  const selector = opts.selector || "[data-hype-crud]";

  function getPrefix(hype?: HypeLike) {
    try {
      if (hype && typeof hype.getConfig === "function") {
        return hype.getConfig().attributePrefix || "hype";
      }
    } catch {
      // ignore and fall through
    }
    return "hype";
  }

  function readAttr(el: Element, prefix: string, name: string) {
    return el.getAttribute(`data-${prefix}-${name}`);
  }

  /**
   * Use Hype's templateClone unconditionally.
   *
   * This project assumes `hype.templateClone` exists and provides safe cloning
   * + interpolation using DOM-safe APIs (textContent/setAttribute).
   *
   * We intentionally remove the fallback interpolation path to keep the code
   * minimal and to rely on Hype's single, high-quality implementation.
   */
  function useTemplateClone(hype: HypeLike, tplSelector: string, item: Record<string, any>) {
    try {
      const tpl = document.querySelector(tplSelector) as HTMLTemplateElement | null;
      if (!tpl) return null;
      // Assume Hype provides a safe templateClone implementation.
      const node = hype && typeof hype.templateClone === "function" ? hype.templateClone(tpl, item) : null;

      if (!node) return null;
      if (node instanceof DocumentFragment) return node;
      const frag = document.createDocumentFragment();
      frag.appendChild(node);
      return frag;
    } catch {
      return null;
    }
  }

  async function fetchListFromEndpoint(endpoint: string, params?: ListParams) {
    const qp = params ? "?" + new URLSearchParams(params as any).toString() : "";
    const res = await fetch(`${endpoint}${qp}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Network error: ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json)) return { items: json };
    if (json && Array.isArray((json as any).items)) return { items: (json as any).items };
    if (json && (json as any).ok && Array.isArray((json as any).items)) return { items: (json as any).items };
    return { items: [] as any[] };
  }

  async function initTable(hype: HypeLike, root: HTMLElement) {
    const prefix = getPrefix(hype);
    const resource = readAttr(root, prefix, "crud") || "";
    const endpoint = readAttr(root, prefix, "crud-endpoint") || undefined;
    const tplSelector = readAttr(root, prefix, "crud-template") || "#item-row-tpl";
    const optimistic = readAttr(root, prefix, "crud-optimistic") === "true";
    const bodyEl = (root.querySelector(".datatable-body") || root.querySelector("tbody") || root) as HTMLElement;

    async function load(params?: ListParams) {
      let res: { items: any[] } = { items: [] };
      try {
        if (hype && hype.crud && typeof hype.crud.list === "function" && resource) {
          res = await hype.crud.list(resource, params || {});
        } else if (endpoint) {
          res = await fetchListFromEndpoint(endpoint, params || {});
        } else {
          res = { items: [] };
        }
      } catch (err) {
        console.warn("datatable load failed", err);
        res = { items: [] };
      }
      render(res.items || []);
      return res.items || [];
    }

    function clear() {
      if (!bodyEl) return;
      if (bodyEl instanceof HTMLTableSectionElement) bodyEl.innerHTML = "";
      else {
        while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
      }
    }

    function render(items: any[]) {
      clear();
      if (!bodyEl) return;
      for (const it of items) {
        const frag = useTemplateClone(hype, tplSelector, it);
        if (frag) {
          bodyEl.appendChild(frag);
        } else {
          // fallback: render simple row
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.textContent = JSON.stringify(it);
          tr.appendChild(td);
          bodyEl.appendChild(tr);
        }
      }
    }

    // event delegation for actions
    root.addEventListener("click", async (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      const action = t.getAttribute("data-action") || (t.dataset && t.dataset.action);
      if (!action) return;

      // id resolution: prefer data-{prefix}-crud-id on ancestor row, then data-id on element
      const row = t.closest(`[data-${prefix}-crud-id]`);
      const id = row ? row.getAttribute(`data-${prefix}-crud-id`) || row.getAttribute("data-id") : t.getAttribute("data-id");

      try {
        if (action === "create") {
          // if a form with data-action="create" exists inside root prefer it
          const createForm = root.querySelector(`form[data-action="create"]`) as HTMLFormElement | null;
          if (createForm) {
            ev.preventDefault();
            const fd = serializeForm(createForm);
            const payload = Object.fromEntries(fd.entries());
            if (hype && hype.crud && resource) {
              await hype.crud.create(resource, payload, { optimistic });
            } else if (endpoint) {
              const { body, contentType } = prepareRequestBody("POST", fd, createForm.getAttribute(`data-${prefix}-encoding`) || undefined);
              await fetch(endpoint, {
                method: "POST",
                credentials: "same-origin",
                headers: contentType ? { "Content-Type": contentType } : undefined,
                body: body as BodyInit,
              });
            }
            await load();
            return;
          }

          // prompt fallback
          ev.preventDefault();
          const title = window.prompt("Create - title:");
          if (!title) return;
          if (hype && hype.crud && resource) {
            await hype.crud.create(resource, { title }, { optimistic });
          } else if (endpoint) {
            await fetch(endpoint, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title }),
            });
          }
          await load();
          return;
        }

        if (action === "edit") {
          if (!id) return;
          ev.preventDefault();
          // prefer inline form inside row
          const rowEl = row as HTMLElement | null;
          const form = rowEl?.querySelector('form[data-action="edit"]') as HTMLFormElement | null;
          if (form) {
            const fd = serializeForm(form);
            const payload = Object.fromEntries(fd.entries());
            if (hype && hype.crud && resource) {
              await hype.crud.update(resource, id, payload, { optimistic });
            } else if (endpoint) {
              await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
                method: "PUT",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
            }
            await load();
            return;
          }
          // prompt fallback
          const newTitle = window.prompt("Edit - new title:");
          if (newTitle === null) return;
          if (hype && hype.crud && resource) {
            await hype.crud.update(resource, id, { title: newTitle }, { optimistic });
          } else if (endpoint) {
            await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
              method: "PUT",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: newTitle }),
            });
          }
          await load();
          return;
        }

        if (action === "delete") {
          if (!id) return;
          ev.preventDefault();
          if (!confirm("Delete?")) return;
          if (hype && hype.crud && resource) {
            await hype.crud.delete(resource, id, { optimistic });
          } else if (endpoint) {
            await fetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
          }
          await load();
          return;
        }

        if (action === "toggle") {
          if (!id) return;
          ev.preventDefault();
          // try update via crud when available; otherwise call a toggle endpoint conventionally
          if (hype && hype.crud && resource) {
            // best-effort: get current cached item if available, flip 'active'
            try {
              const current = typeof hype.crud.get === "function" ? await hype.crud.get(resource, id) : null;
              const next = current ? !current.active : true;
              await hype.crud.update(resource, id, { active: next }, { optimistic: true });
            } catch {
              // fallback to endpoint-based toggle
              const toggleEndpoint = readAttr(root, prefix, "crud-toggle") || `${endpoint}/${encodeURIComponent(id)}/toggle`;
              if (toggleEndpoint) await fetch(toggleEndpoint, { method: "POST", credentials: "same-origin" });
            }
          } else {
            const toggleEndpoint = readAttr(root, prefix, "crud-toggle") || `${endpoint}/${encodeURIComponent(id)}/toggle`;
            if (toggleEndpoint) await fetch(toggleEndpoint, { method: "POST", credentials: "same-origin" });
          }
          await load();
          return;
        }
      } catch (err) {
        // surface minimal warning; concrete error handling left to callers/pages
        // do not leak sensitive internals
        // eslint-disable-next-line no-console
        console.warn("datatable action failed", action, err);
        // best-effort refresh so UI is not permanently inconsistent
        try {
          await load();
        } catch {
          // ignore
        }
      }
    });

    // initial render
    await load();
  }

  async function install(hype?: HypeLike) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const n of nodes) {
      // avoid re-initializing the same root
      if ((n as any)._datatableInitialized) continue;
      try {
        await initTable(hype, n as HTMLElement);
        (n as any)._datatableInitialized = true;
      } catch (err) {
        // swallow init errors so one broken table doesn't break the rest
        // eslint-disable-next-line no-console
        console.warn("datatable init failed for", n, err);
      }
    }
  }

  return {
    name: "datatable",
    install,
  };
}

export default createDataTablePlugin;
