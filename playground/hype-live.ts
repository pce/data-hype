// Minimal "hype live" client runtime sketch (TypeScript)
// - Connects via WebSocket
// - Joins live views declared with data-hype-live="<view>"
//
// NOTE: production implementation should add types, error handling, reconnection backoff, auth.

type ServerMsg = { type: "patch"; id: string; html: string; tx?: number } | { type: "redirect"; url: string } | { type: "event"; name: string; payload?: any };

type ClientMsg =
  | { type: "join"; id: string; view: string; params?: any }
  | { type: "event"; id: string; name: string; payload?: any; tx?: number }
  | { type: "heartbeat" };

function createLiveClient(url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/_hype_live") {
  const ws = new WebSocket(url);
  const pending = new Map<number, (ok: boolean) => void>();
  let tx = 0;

  ws.onopen = () => {
    document.querySelectorAll("[data-hype-live]").forEach((el) => {
      const id = el.getAttribute("data-hype-id") || generateId();
      el.setAttribute("data-hype-id", id);
      const view = el.getAttribute("data-hype-live")!;
      send({ type: "join", id, view });
    });
  };

  ws.onmessage = (ev) => {
    try {
      const msg: ServerMsg = JSON.parse(ev.data);
      if (msg.type === "patch") {
        const target = document.querySelector(`[data-hype-id="${msg.id}"]`);
        if (target && typeof msg.html === "string") {
          // Use morphdom if available to preserve state; fallback to innerHTML replace
          if ((window as any).morphdom) {
            (window as any).morphdom(target, wrapHtml(msg.html));
          } else {
            target.innerHTML = msg.html;
          }
        }
      } else if (msg.type === "redirect") {
        window.location.href = msg.url;
      } else {
        document.dispatchEvent(new CustomEvent("hype:live:event", { detail: msg }));
      }
    } catch (err) {
      console.error("invalid live message", err);
    }
  };

  ws.onclose = () => {
    // TODO: reconnect backoff
    console.warn("hype live socket closed");
  };

  function send(obj: ClientMsg) {
    ws.send(JSON.stringify(obj));
  }

  function pushEvent(el: Element, name: string, payload?: any) {
    send({ type: "event", id: el.getAttribute("data-hype-id")!, name, payload, tx: ++tx });
  }

  // Helper to wrap fragment into a root element for morphdom
  function wrapHtml(html: string) {
    // If html is a single root, return it as-is; else wrap in container
    return html.trim().startsWith("<") ? html : `<div>${html}</div>`;
  }

  function generateId() {
    return "h" + Math.random().toString(36).slice(2, 9);
  }

  // Expose public API
  return { pushEvent, send };
}

export { createLiveClient };
