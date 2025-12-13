/**
 * Dev server with static example pages, Hype Live WS protocol, Stocks WS, and SSE endpoints.
 *
 * Enhanced:
 *  - Per-request Content-Security-Policy with nonce
 *  - CSRF protection using cookie-based csurf
 *  - CSRF token endpoint: GET /csrf-token
 *  - Error handler for CSRF and other errors
 *
 * Notes:
 *  - This server is intended for local development only.
 *  - In production you should tighten auth, CORS and other protections and manage secrets appropriately.
 */

import express from "express";
import http from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
// @ts-ignore: optional dev dependency in the playground dev-server; types may not be present in all environments
import csurf from "csurf";
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
   Simple auth tokens (demo)
   - signAuthToken / verifyAuthToken
   - cookie helpers: setAuthCookie / clearAuthCookie
   - requireAuth middleware
   ------------------------- */

const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "dev-auth-secret-change-me";
const AUTH_COOKIE_NAME = "auth_token";

function signAuthToken(subject: string, ttlSec = 60 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = JSON.stringify({ sub: subject, exp });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifyAuthToken(token: string | undefined | null) {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [b64, sig] = parts;
    const expected = crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(b64).digest("base64url");
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

// Helper to set auth cookie on response
function setAuthCookie(res: express.Response, token: string, ttlSec = 60 * 60) {
  const cookieOptions: any = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ttlSec * 1000,
    path: "/",
  };
  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions);
}

// Helper to clear auth cookie
function clearAuthCookie(res: express.Response) {
  res.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
}

// Middleware to require authentication for API endpoints
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = (req.cookies && (req.cookies as any)[AUTH_COOKIE_NAME]) || req.header("Authorization")?.replace(/^Bearer\s+/, "");
    const payload = verifyAuthToken(token as string | undefined);
    if (!payload) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    // attach user info to request for handlers
    (req as any).user = { id: payload.sub };
    next();
  } catch (err) {
    res.status(401).json({ ok: false, error: "unauthorized" });
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
  </div>
  <div>Score: ${escapeHtml(it.score)}</div>
  <div>Active: ${it.active ? "yes" : "no"}</div>
</li>`,
    )
    .join("\n");
  return `<ul id="items-list-1">${list}</ul>`;
}

function renderRegionHtmlForId(id: string) {
  // Simple example: return a fragment that the client will use to patch a region.
  // If you need to include inline scripts here, use res.locals.cspNonce when serving via Express.
  return `<div data-region-id="${escapeHtml(id)}">${renderItemsFragment()}</div>`;
}

function broadcastPatch(id: string, html: string, tx?: number) {
  const subs = liveSubscribers.get(id);
  if (!subs) return;
  const msg: ServerMsg = { type: "patch", id, html, tx };
  const data = JSON.stringify(msg);
  for (const ws of subs) {
    try {
      ws.send(data);
    } catch {
      // ignore send errors
    }
  }
}

function broadcastStockUpdate(s: Stock) {
  const payload = { type: "stock:update", symbol: s.symbol, price: s.price, change: s.change, timestamp: s.timestamp };
  const text = JSON.stringify(payload);
  // send to WS stock clients
  for (const ws of stocksClients) {
    try {
      ws.send(text);
    } catch {}
  }
  // send to SSE clients
  for (const res of sseClients) {
    try {
      res.write(`data: ${text}\n\n`);
    } catch {}
  }
}

function sendStocksSnapshot(ws: WebSocket, symbols?: string[]) {
  const itemsArr = Object.values(stocks).filter((s) => (symbols ? symbols.includes(s.symbol) : true));
  const payload = { type: "stocks:snapshot", items: itemsArr };
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

function sendSseSnapshot(res: ServerResponse, symbols?: string[]) {
  const itemsArr = Object.values(stocks).filter((s) => (symbols ? symbols.includes(s.symbol) : true));
  const payload = { type: "stocks:snapshot", items: itemsArr };
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

/* -------------------------
   Express app + security middleware
   ------------------------- */

const app = express();

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Per-request CSP + other security headers middleware
// NOTE: we no longer allow 'unsafe-inline'. Instead we generate a per-request nonce
// and expose it via res.locals.cspNonce so server-rendered HTML can use the nonce
// for inline style/script tags (preferred: move inline code into external modules).
app.use((req, res, next) => {
  try {
    // generate a per-request nonce (base64)
    const nonce = crypto.randomBytes(16).toString("base64");
    (res.locals as any).cspNonce = nonce;

    // Use nonce-only for scripts and styles (no 'unsafe-inline')
    const scriptSrc = `'self' 'nonce-${nonce}'`;
    const styleSrc = `'self' 'nonce-${nonce}' https:`;

    const csp = [
      `default-src 'self'`,
      `script-src ${scriptSrc}`,
      `style-src ${styleSrc}`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `frame-ancestors 'none'`,
    ].join("; ");

    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  } catch (e) {
    // ignore header-setting errors in dev
  }
  next();
});

/*
  CSRF protection: use cookie-based csurf.
  This will:
    - Populate req.csrfToken() for handlers (GET can call it to provide token)
    - Validate non-GET requests for the token sent via header or body/query param
  The client should send the token in the 'X-CSRF-Token' header (or conventional names).
*/
const csrfProtection = csurf({
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // path: '/', // default
  },
});

// Apply CSRF protection globally for mutating requests. We register it as middleware so
// that GETs still produce a token (req.csrfToken) and non-safe methods are checked.
app.use(csrfProtection);

/* -------------------------
   Static files and routes (unchanged behavior, with CSRF tokens available)
   ------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

if (!fs.existsSync(publicDir)) {
  console.warn(`Dev server public directory not found: ${publicDir}`);
}

// Serve HTML files with per-request nonce injection so CSP can remain strict.
// This middleware will attempt to read .html files from the public directory,
// replace any occurrence of the token %CSP_NONCE% with the generated nonce,
// and inject a <meta name="csp-nonce"> tag into the <head> if one is not present.
// For non-HTML assets fall through to the static server below.
app.use((req, res, next) => {
  try {
    const accept = req.headers.accept || "";
    const wantsHtml = req.path === "/" || req.path.endsWith(".html") || accept.includes("text/html");

    if (wantsHtml) {
      const targetPath = req.path === "/" ? "index.html" : req.path.replace(/^\/+/, "");
      const filePath = path.join(publicDir, targetPath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const nonce = (res.locals as any).cspNonce || crypto.randomBytes(16).toString("base64");
        let html = fs.readFileSync(filePath, "utf8");

        // Replace any explicit placeholder tokens with the nonce.
        // Authors can include %CSP_NONCE% in templates where they need the nonce
        // attribute (for example: <script nonce="%CSP_NONCE%"> ... </script>).
        html = html.replace(/%CSP_NONCE%/g, nonce);

        // If no meta tag exists to expose the nonce, inject one into <head>.
        if (!/meta[^>]*name=(?:'|")csp-nonce(?:'|")/i.test(html)) {
          html = html.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="csp-nonce" content="${nonce}">`);
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(html);
        return;
      }
    }
  } catch (e) {
    // If any injection step fails, fall back to static serving
  }
  next();
});

// Serve other static assets (images, js, css, etc.)
app.use(express.static(publicDir, { extensions: ["html"] }));

// Public API endpoints
/* -------------------------
   Auth routes (demo)
   - POST /login  -> accepts simple credentials, issues auth cookie (JWT-like HMAC token)
   - POST /logout -> clears auth cookie
   - GET  /me     -> returns authenticated user info
   Note: This is a demo implementation. Replace credential checks with real user store / hashing in production.
   CSRF protection applies (client should fetch /csrf-token and send X-CSRF-Token for POSTs).
   ------------------------- */

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  // Demo credential check: accept any non-empty username, and optional simple password check.
  // Replace this with real user lookup and password verification (bcrypt/argon2) in production.
  if (!username || typeof username !== "string" || username.trim() === "") {
    res.status(400).json({ ok: false, error: "username required" });
    return;
  }

  // Example: simple hard-coded check (for demo only)
  // Accept any username, or enforce username === "demo" && password === "password" if you prefer stricter demo behavior.
  // if (username !== "demo" || password !== "password") {
  //   res.status(401).json({ ok: false, error: "invalid credentials" });
  //   return;
  // }

  const token = signAuthToken(username, 60 * 60); // 1 hour
  setAuthCookie(res, token, 60 * 60);

  // Optionally return the token in response body for SPA clients (but cookie is the primary auth channel here)
  res.json({ ok: true, user: { id: username } });
});

app.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/me", (req, res) => {
  const token = (req.cookies && (req.cookies as any)[AUTH_COOKIE_NAME]) || req.header("Authorization")?.replace(/^Bearer\s+/, "");
  const payload = verifyAuthToken(token as string | undefined);
  if (!payload) {
    res.status(401).json({ ok: false, error: "unauthenticated" });
    return;
  }
  res.json({ ok: true, user: { id: payload.sub } });
});

/* -------------------------
   Public API: items
   ------------------------- */

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

/* -------------------------
   CSRF token endpoint
   ------------------------- */

app.get("/csrf-token", (req, res) => {
  // Return the token to the client so it can be used for subsequent mutating requests.
  // The middleware also sets a cookie-based secret; the client should send the token in header 'X-CSRF-Token'.
  try {
    const token = (req as any).csrfToken();
    res.json({ ok: true, csrfToken: token });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Unable to generate CSRF token" });
  }
});

/* -------------------------
   Snapshot and join token endpoints
   ------------------------- */

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

/* -------------------------
   Toggle item endpoint (POST - protected by CSRF)
   ------------------------- */

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
   Error handling (CSRF + generic)
   ------------------------- */

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next();
  // csurf throws an error with code 'EBADCSRFTOKEN' for invalid/missing tokens
  if (err.code === "EBADCSRFTOKEN") {
    res.status(403).json({ ok: false, error: "invalid csrf token" });
    return;
  }
  console.error("Server error:", err && (err.stack || err.message || err));
  // for HTML responses you might want to render a friendly page; keep JSON for API endpoints here:
  if (!res.headersSent) {
    res.status(err.status || 500).json({ ok: false, error: err.message || "internal server error" });
  } else {
    // headers already sent; delegate to default error handler
    next(err);
  }
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
