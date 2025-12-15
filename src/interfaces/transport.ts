/**
 * src/interfaces/transport.ts
 *
 * Minimal Pub/Sub transport abstraction and a small WebSocket-based implementation.
 *
 * Purpose:
 * - Provide a tiny, swappable transport abstraction for server push and client publish
 * - Keep surface area small so core Hype can depend on the interface (DIP)
 *
 */

export type TransportMessage = {
  // optional semantic type (e.g. 'snapshot'|'patch'|'pub'|'event')
  type?: string;
  // optional topic for pub/sub routing
  topic?: string;
  // arbitrary payload
  payload?: any;
  // optional target selector or id (for server -> client UI messages)
  target?: string;
  // other metadata allowed
  [k: string]: any;
};

export interface PubSubTransport {
  /**
   * Optional connect step. Implementations that need to establish a long-lived
   * connection (WebSocket) should implement this. It may be sync or return a Promise.
   */
  connect?(opts?: { url?: string }): Promise<void> | void;

  /**
   * Optional disconnect/cleanup step.
   */
  disconnect?(): void;

  /**
   * Publish a message to the server.
   * Implementations decide wire format; the simple convention is to send JSON
   * containing { type: 'pub', topic, payload } but transports are free to vary.
   */
  publish(topic: string, payload?: any): void;

  /**
   * Subscribe to a logical topic. Returns an object with an `unsubscribe()` method.
   * The transport decides how to map topics to server-side subscriptions.
   */
  subscribe(topic: string, handler: (payload: any, msg?: TransportMessage) => void): { unsubscribe(): void };

  /**
   * Optional: register a handler that receives raw incoming TransportMessage objects.
   * Useful for messages that don't map to a single topic (e.g. snapshot/patch shapes).
   */
  onRawMessage?(handler: (msg: TransportMessage) => void): void;
}

/**
 * No-op transport for tests or environments where server push is not desired.
 */
export const NoopTransport: PubSubTransport = {
  connect() {},
  disconnect() {},
  publish() {},
  subscribe() {
    return { unsubscribe() {} };
  },
  onRawMessage() {},
};

/**
 * Options for createWebSocketTransport
 */
export type WebSocketTransportOptions = {
  /**
   * When true, automatically call connect() when transport is created.
   * Defaults to false.
   */
  autoConnect?: boolean;
  /**
   * Optional function to transform outgoing messages before sending.
   * Receives { type?, topic?, payload?, target? } and should return something serializable
   * (commonly JSON).
   */
  encode?: (msg: TransportMessage) => string;
  /**
   * Optional function to transform incoming raw strings into objects.
   * Defaults to JSON.parse with try/catch.
   */
  decode?: (raw: string) => any;
};

/**
 * Create a conservative WebSocket-based PubSubTransport.
 *
 * - The transport attempts to parse incoming messages as JSON. If parsed object has
 *   `topic` property (string), it will dispatch payload to topic subscribers.
 * - Raw parsed messages are forwarded to `onRawMessage` handler if registered.
 *
 * Usage:
 *   const t = createWebSocketTransport('wss://example/ws', { autoConnect: true });
 *   t.onRawMessage?.((m) => { ... });
 *   const sub = t.subscribe('items:update', (payload) => {});
 *   t.publish('items:refresh', { id: 123 });
 */
export function createWebSocketTransport(wsUrl: string, opts?: WebSocketTransportOptions): PubSubTransport {
  const subs = new Map<string, Set<(p: any, msg?: TransportMessage) => void>>();
  let socket: WebSocket | null = null;
  let rawHandler: ((m: TransportMessage) => void) | undefined;
  const encode = opts?.encode || ((m: TransportMessage) => JSON.stringify(m));
  const decode = opts?.decode || ((raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      // If not JSON, return raw string so onRawMessage consumers can handle it
      return raw;
    }
  });

  function dispatchIncoming(parsed: any) {
    try {
      // normalize to TransportMessage shape if possible
      const msg: TransportMessage = parsed && typeof parsed === "object" ? parsed : { payload: parsed };
      // call raw handler first
      if (rawHandler) {
        try {
          rawHandler(msg);
        } catch {
          // swallow user handler errors
        }
      }
      // dispatch to topic subscribers if topic is present
      const topic = typeof msg.topic === "string" ? msg.topic : undefined;
      if (topic) {
        const set = subs.get(topic);
        if (set) {
          // copy to array to avoid mutation during iteration
          for (const h of Array.from(set)) {
            try {
              h(msg.payload, msg);
            } catch {
              // swallow handler errors
            }
          }
        }
      }
    } catch {
      // ignore dispatch errors
    }
  }

  function ensureSocket() {
    if (socket) return;
    try {
      socket = new WebSocket(wsUrl);
      socket.addEventListener("message", (ev) => {
        const data = ev.data;
        try {
          const parsed = decode(typeof data === "string" ? data : String(data));
          dispatchIncoming(parsed);
        } catch {
          // ignore parse errors
        }
      });
      socket.addEventListener("close", () => {
        socket = null;
      });
      socket.addEventListener("error", () => {
        // errors are surfaced via socket state; keep behavior minimal
      });
    } catch {
      // Could not construct WebSocket in this environment (maybe SSR). Leave socket null.
      socket = null;
    }
  }

  const transport: PubSubTransport = {
    connect() {
      ensureSocket();
    },

    disconnect() {
      try {
        if (socket) {
          socket.close();
        }
      } finally {
        socket = null;
      }
    },

    publish(topic: string, payload?: any) {
      const msg: TransportMessage = { type: "pub", topic, payload };
      const out = encode(msg);
      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(out);
          return;
        }
        // If socket is not open, attempt ephemeral send: open a one-shot socket and send when open.
        // This avoids silently dropping messages in simple setups.
        const tmp = new WebSocket(wsUrl);
        const cleanup = () => {
          try {
            tmp.close();
          } catch {}
        };
        tmp.addEventListener("open", () => {
          try {
            tmp.send(out);
          } catch {}
          // close a short moment later to allow server to receive
          setTimeout(cleanup, 50);
        });
        tmp.addEventListener("error", cleanup);
        tmp.addEventListener("close", cleanup);
      } catch {
        // swallow send errors
      }
    },

    subscribe(topic: string, handler: (payload: any, msg?: TransportMessage) => void) {
      let set = subs.get(topic);
      if (!set) {
        set = new Set();
        subs.set(topic, set);
      }
      set.add(handler);
      // Return unsubscribe handle
      return {
        unsubscribe() {
          try {
            set!.delete(handler);
            if (set!.size === 0) subs.delete(topic);
          } catch {
            // swallow
          }
        },
      };
    },

    onRawMessage(handler: (m: TransportMessage) => void) {
      rawHandler = handler;
    },
  };

  if (opts?.autoConnect) {
    try {
      transport.connect?.();
    } catch {
      // ignore connect errors
    }
  }

  return transport;
}
