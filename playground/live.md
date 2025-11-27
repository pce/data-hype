# Hype Live Protocol (compact)

Transport: WebSocket (wss for TLS)

Client -> Server messages (JSON):
- join: { type: "join", id: "<node-id>", view: "users/show", params?: {} }
- event: { type: "event", id: "<node-id>", name: "click:delete" | "form:submit", payload?: {}, tx?: number }
- heartbeat: { type: "heartbeat" }

Server -> Client messages:
- patch: { type: "patch", id: "<node-id>", html: "<div>...</div>", tx?: number }
- redirect: { type: "redirect", url: "/users" }
- event: { type: "event", name: "notification", payload?: {} }
- ack/error: { type: "ack", tx: number, ok: true } or { type: "error", tx: number, message: "..." }

Lifecycle:
- Client sends join when element with data-hype-live is detected
- Server runs mount(view, params, socket) and sends initial patch
- Client sends events when user interacts; server runs handle_event and then pushes patch(s)
- Server may push events asynchronously (handle_info or broadcast)
- Client handles reconnects by re-sending join; server should re-render current state

Security:
- Authenticate WS using session cookie or signed token in query param or first message
- Validate all incoming payloads server-side
- Rate-limit event messages per session

Diffing:
- Start with full HTML patch + morphdom
- Optionally implement structured ops later for bandwidth optimization
