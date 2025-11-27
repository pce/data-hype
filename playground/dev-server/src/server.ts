/**
 * Dev server with static example pages, Hype Live WS protocol, Stocks WS, and SSE endpoints.
 *
 * This file extends the previous minimal dev server with:
 *  - WS /_hype_live  -> Hype live protocol (join/ event / patch)
 *  - WS /stocks/ws   -> simple stocks websocket (subscribe/unsubscribe/snapshot/update)
 *  - GET /stocks/sse -> Server-Sent Events feed for stocks (snapshot + updates)
 *
 * Notes:
 *  - This server is intended for local development only.
 *  - In production you should tighten auth, CORS and other protections.
 */

import express from "express";
import http from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { IncomingMessage, ServerResponse } from "http";
import crypto from "crypto";

/* -------------------------
   Join token helpers (same as before)
   ------------------------- */

const JOIN_TOKEN_SECRET = process.env.HYPE_JOIN_SECRET || "dev-secret-change-me";

function signJoinToken(nodeId: string, ttlSec = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = JSON.stringify({ id: nodeId, exp });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", JOIN_TOKEN_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifyJoinToken(token: string) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [b64, sig] = parts;
    const expected = crypto.createHmac("sha256", JOIN_TOKEN_SECRET).update(b64).digest("base64url");
    if (sig !== expected) return null;
    const payloadJson = Buffer.from(b64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/* -------------------------
   Types
   ------------------------- */

type ClientMsg =
  | { type: "join"; id: string; view?: string; params?: Record<string, any>; auth?: string }
  | { type: "event"; id: string; name: string; payload?: any; tx?: number }
  | { type: "heartbeat" };

type ServerMsg = { type: "patch"; id: string; html: string; tx?: number } | { type: "redirect"; url: string } | { type: "event"; name: string; payload?: any };

interface Item {
  id: string;
  title: string;
  score: number;
  active: boolean;
}

/* -------------------------
   State: demo items (unchanged)
   ------------------------- */

const items: Record<string, Item> = {
  "1": { id: "1", title: "Alpha", score: 3, active: true },
  "2": { id: "2", title: "Bravo", score: 7, active: true },
  "3": { id: "3", title: "Charlie", score: 1, active: false },
};

// Simple in-memory jobs demo state for favorite toggling.
// This backs the frontend example that posts to /api/jobs/:id/toggle-favorite
interface Job {
  id: string;
  title: string;
  favorited: boolean;
}
const jobs: Record<string, Job> = {
  "123": { id: "123", title: "Frontend Engineer", favorited: false },
  "456": { id: "456", title: "Backend Engineer", favorited: true },
  "789": { id: "789", title: "DevOps Engineer", favorited: false },
};

/* -------------------------
   Hype Live subscriptions (hype-id -> Set<WebSocket>)
   ------------------------- */

const liveSubscribers: Map<string, Set<WebSocket>> = new Map();

/* -------------------------
   Stocks state & clients
   ------------------------- */

type Stock = { symbol: string; price: number; change: number; timestamp: number };

const STOCK_SYMBOLS = ["AAPL", "GOOG", "MSFT", "TSLA", "AMZN", "NFLX", "META", "INTC", "AMD"];
const stocks: Record<string, Stock> = {};

// seed initial stock values
for (const sym of STOCK_SYMBOLS) {
  stocks[sym] = { symbol: sym, price: 100 + Math.random() * 200, change: 0, timestamp: Date.now() };
}

// WebSocket clients for stocks
const stocksClients = new Set<WebSocket>();

// SSE clients (raw http.ServerResponse objects)
const sseClients = new Set<ServerResponse>();

/* -------------------------
   Helpers
   ------------------------- */

function escapeHtml(s: string | number) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/* -------------------------
   Hype Live rendering and broadcast
   ------------------------- */

function renderItemsFragment(): string {
  const list = Object.values(items)
    .map(
      (it) => `
<li class="item" data-id="${escapeHtml(it.id)}">
  <div>
    <strong>${escapeHtml(it.title)}</strong>
    <div class="meta">score: <span class="meta-value">${it.score}</span></div>
  </div>
  <div>
    <form action="/items/${encodeURIComponent(it.id)}/toggle" method="post" class="inline-action" data-hype-swap="outerHTML">
      <input type="hidden" name="csrf_token" value="DUMMY_CSRF_TOKEN" />
      <button class="btn" type="submit">${it.active ? "Deactivate" : "Activate"}</button>
    </form>
  </div>
</li>`,
    )
    .join("\n");

  return `<ul class="items" aria-describedby="items-desc">\n${list}\n</ul>`;
}

function renderRegionHtmlForId(nodeId: string): string {
  if (nodeId === "items-list-1") {
    return renderItemsFragment();
  }
  return `<div data-hype-id="${escapeHtml(nodeId)}"></div>`;
}

function broadcastPatch(id: string, html: string, tx?: number) {
  const subs = liveSubscribers.get(id);
  if (!subs) return;
  const msg: ServerMsg = { type: "patch", id, html, tx };
  const data = JSON.stringify(msg);
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

/* -------------------------
   Stocks broadcast helpers
   ------------------------- */

function broadcastStockUpdate(stock: Stock) {
  const payload = { type: "update", symbol: stock.symbol, price: stock.price, change: stock.change, timestamp: stock.timestamp };
  const text = JSON.stringify(payload);

  // WS clients
  for (const ws of stocksClients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(text);
      } catch (e) {
        // ignore per-client errors
      }
    }
  }

  // SSE clients
  for (const res of sseClients) {
    try {
      res.write(`data: ${text}\n\n`);
    } catch (e) {
      // ignore; closed clients are cleaned up elsewhere
    }
  }
}

function sendStocksSnapshot(ws: WebSocket, symbols?: string[]) {
  const itemsArr = (symbols && symbols.length > 0 ? symbols : Object.keys(stocks)).map((s) => stocks[s]).filter(Boolean);
  try {
    ws.send(JSON.stringify({ type: "snapshot", items: itemsArr }));
  } catch (e) {
    /* ignore */
  }
}

function sendSseSnapshot(res: ServerResponse, symbols?: string[]) {
  const itemsArr = (symbols && symbols.length > 0 ? symbols : Object.keys(stocks)).map((s) => stocks[s]).filter(Boolean);
  const payload = { type: "snapshot", items: itemsArr };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/* -------------------------
   Express app + static
   ------------------------- */

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

if (!fs.existsSync(publicDir)) {
  console.warn(`Dev server public directory not found: ${publicDir}`);
}

app.use(express.static(publicDir, { extensions: ["html"] }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/api/items", (_req, res) => {
  const list = Object.values(items);
  res.json({ ok: true, items: list });
});

// Jobs API for the favorite button examples
app.get("/api/jobs", (_req, res) => {
  const list = Object.values(jobs);
  res.json({ ok: true, jobs: list });
});

app.post("/api/jobs/:id/toggle-favorite", (req, res) => {
  const id = String(req.params.id || "");
  const job = jobs[id];
  if (!job) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  // Toggle favorite state
  job.favorited = !job.favorited;

  // Respond with updated job state (JSON expected by the frontend)
  res.json({ ok: true, job: { ...job } });
});

app.get("/_hype_snapshot/:id", (req, res) => {
  const id = req.params.id;
  const html = renderRegionHtmlForId(id);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/_hype_join_token/:id", (req, res) => {
  const id = String(req.params.id || "");
  const token = signJoinToken(id, 300);
  res.json({ ok: true, id, token });
});

app.post("/items/:id/toggle", (req, res) => {
  const id = req.params.id;
  const item = items[id];
  if (!item) {
    res.status(404).send("Not found");
    return;
  }

  item.active = !item.active;
  item.score = Math.max(0, item.score + (item.active ? 1 : -1));

  const regionHtml = renderItemsFragment();
  broadcastPatch("items-list-1", regionHtml);

  const accept = (req.headers["accept"] || "").toString();
  if (accept.includes("application/json")) {
    res.json({ ok: true, patch: { id: "items-list-1", html: regionHtml } });
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(regionHtml);
  }
});

/* -------------------------
   Stocks SSE endpoint
   ------------------------- */

app.get("/stocks/sse", (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // for nginx proxy buffering

  // flush a comment to establish the stream in some proxies
  res.write(":ok\n\n");

  // Optionally accept ?symbols=AAPL,GOOG to send a filtered snapshot
  const symbolsParam = (req.query.symbols || "") as string;
  const symbols = symbolsParam
    ? symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : undefined;

  // Add to clients set
  sseClients.add(res);

  // send initial snapshot
  try {
    sendSseSnapshot(res, symbols);
  } catch (e) {
    // ignore
  }

  // heartbeat to keep connection alive
  const pingInterval = setInterval(() => {
    try {
      res.write(":ping\n\n");
    } catch (e) {
      // ignore
    }
  }, 20000);

  // cleanup when client disconnects
  req.on("close", () => {
    clearInterval(pingInterval);
    sseClients.delete(res);
    try {
      res.end();
    } catch (_) {}
  });
});

/* -------------------------
   HTTP server + WS servers
   ------------------------- */

const PORT = Number(process.env.PORT || 3000);
const httpServer = http.createServer(app);

// Create two independent WebSocketServer instances and route upgrade by URL.
// We use noServer: true so we control the upgrade dispatching.
const wssLive = new WebSocketServer({ noServer: true });
const wssStocks = new WebSocketServer({ noServer: true });

/**
 * Route upgrade requests to the appropriate WebSocketServer based on the
 * request URL. This allows /_hype_live and /stocks/ws to coexist.
 */
httpServer.on("upgrade", function upgrade(request: IncomingMessage, socket, head) {
  const { url } = request;
  if (!url) {
    socket.destroy();
    return;
  }

  if (url.startsWith("/_hype_live")) {
    wssLive.handleUpgrade(request, socket, head, function done(ws) {
      wssLive.emit("connection", ws, request);
    });
    return;
  }

  if (url.startsWith("/stocks/ws")) {
    wssStocks.handleUpgrade(request, socket, head, function done(ws) {
      wssStocks.emit("connection", ws, request);
    });
    return;
  }

  // Not handled: fallback to destroying socket
  socket.destroy();
});

/* -------------------------
   Hype Live WS handling (same semantics as before)
   ------------------------- */

wssLive.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  console.log("live socket connected:", req.socket.remoteAddress);

  const joinedIds = new Set<string>();

  ws.on("message", (data) => {
    let msg: ClientMsg | null = null;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch (err) {
      console.warn("invalid ws message", err);
      return;
    }

    if (msg?.type === "join") {
      const nodeId = msg.id;

      let allowed = false;
      if (msg.auth && typeof msg.auth === "string") {
        const payload = verifyJoinToken(msg.auth);
        if (payload && payload.id === nodeId) {
          allowed = true;
        }
      } else {
        if (process.env.NODE_ENV !== "production") allowed = true;
      }

      if (!allowed) {
        try {
          ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
        } catch {}
        ws.close(4001, "unauthorized");
        return;
      }

      joinedIds.add(nodeId);
      if (!liveSubscribers.has(nodeId)) liveSubscribers.set(nodeId, new Set());
      liveSubscribers.get(nodeId)!.add(ws);

      const fragment = renderRegionHtmlForId(nodeId);
      const reply: ServerMsg = { type: "patch", id: nodeId, html: fragment };
      try {
        ws.send(JSON.stringify(reply));
      } catch {}
      return;
    }

    if (msg?.type === "event") {
      const nodeId = msg.id;
      const name = msg.name;

      if (typeof nodeId !== "string" || typeof name !== "string") {
        return;
      }

      if (name === "toggle" || name === "form:submit") {
        const payload = msg.payload || {};
        const targetId = payload.id || "1";

        if (items[targetId]) {
          const it = items[targetId];
          it.active = !it.active;
          it.score = Math.max(0, it.score + (it.active ? 1 : -1));
        }

        const html = renderItemsFragment();
        broadcastPatch("items-list-1", html, msg.tx);
      }

      return;
    }

    if (msg?.type === "heartbeat") {
      return;
    }
  });

  ws.on("close", () => {
    for (const id of joinedIds) {
      const set = liveSubscribers.get(id);
      if (!set) continue;
      set.delete(ws);
      if (set.size === 0) liveSubscribers.delete(id);
    }
    console.log("live socket disconnected");
  });

  ws.on("error", (err) => {
    console.error("ws live error", err);
  });
});

/* -------------------------
   Stocks WS handling
   ------------------------- */

wssStocks.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  console.log("stocks ws connected:", req.socket.remoteAddress);

  // Track which symbols this socket subscribed to (empty => all)
  const subscribed = new Set<string>();
  stocksClients.add(ws);

  // Send initial snapshot
  sendStocksSnapshot(ws);

  ws.on("message", (data) => {
    let msg: any = null;
    try {
      msg = JSON.parse(String(data));
    } catch (err) {
      // ignore unparsable messages
      return;
    }

    // expected shapes, e.g. { type: 'subscribe', symbol: 'AAPL' } or { type: 'unsubscribe', symbol: 'AAPL' }
    if (msg && typeof msg.type === "string") {
      if (msg.type === "subscribe" && typeof msg.symbol === "string") {
        subscribed.add(msg.symbol.toUpperCase());
        // send snapshot for that symbol
        sendStocksSnapshot(ws, [msg.symbol.toUpperCase()]);
      } else if (msg.type === "unsubscribe" && typeof msg.symbol === "string") {
        subscribed.delete(msg.symbol.toUpperCase());
      } else if (msg.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {}
      }
    }
  });

  ws.on("close", () => {
    stocksClients.delete(ws);
    // cleanup any internal state if needed
  });

  ws.on("error", (err) => {
    console.error("stocks ws error", err);
    stocksClients.delete(ws);
  });
});

/* -------------------------
   Periodic stock updates (simulated)
   ------------------------- */

const STOCK_UPDATE_INTERVAL = 800; // ms
const stockUpdater = setInterval(() => {
  // randomly pick a symbol to mutate
  const syms = Object.keys(stocks);
  if (!syms.length) return;
  const sym = syms[Math.floor(Math.random() * syms.length)];
  const s = stocks[sym];
  const change = +(Math.random() * 2 - 1).toFixed(2); // -1..+1
  s.price = Math.max(0.01, +(s.price + change).toFixed(2));
  s.change = change;
  s.timestamp = Date.now();

  // Broadcast to WS and SSE clients
  broadcastStockUpdate(s);
}, STOCK_UPDATE_INTERVAL);

/* -------------------------
   Start server
   ------------------------- */

httpServer.listen(PORT, () => {
  console.log(`Dev server listening on http://localhost:${PORT}`);
  console.log(`Static examples served from: ${publicDir}`);

  try {
    const entries = fs.readdirSync(publicDir, { withFileTypes: true });
    const files = entries
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();

    if (files.length > 0) {
      console.log("Static example files:");
      for (const f of files) {
        if (f.toLowerCase() === "index.html") {
          console.log(`  - http://localhost:${PORT}/    (index)`);
        }
        console.log(`  - http://localhost:${PORT}/${f}`);
      }
    } else {
      console.log("  (no static files found in public directory)");
    }
  } catch (err) {
    console.warn("Unable to read public directory for listing:", err && (err as Error).message ? (err as Error).message : err);
  }

  console.log("WebSocket endpoints:");
  console.log("  - ws://<host>/_hype_live   (Hype live protocol)");
  console.log("  - ws://<host>/stocks/ws   (stocks protocol)");
  console.log("SSE endpoint: GET /stocks/sse");
});

/* -------------------------
   Graceful shutdown
   ------------------------- */

const shutdown = () => {
  console.log("Shutting down server...");
  try {
    clearInterval(stockUpdater);
  } catch {}
  wssLive.clients.forEach((c) => {
    try {
      c.terminate();
    } catch {}
  });
  wssStocks.clients.forEach((c) => {
    try {
      c.terminate();
    } catch {}
  });
  // close SSE clients
  for (const res of sseClients) {
    try {
      res.end();
    } catch {}
  }

  httpServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
