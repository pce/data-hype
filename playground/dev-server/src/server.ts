/**
 * Dev server with static example pages, Hype Live WS protocol, Stocks WS, and SSE endpoints.
 *
 * Enhanced for production-readiness:
 *  - Helmet for secure headers (CSP still generated per-request to support nonces)
 *  - HSTS header prepared for production (only applied when NODE_ENV === 'production')
 *  - trust proxy when behind a reverse proxy (production)
 *  - Origin validation for WS and SSE endpoints in production
 *
 * Notes:
 *  - This server is intended for local development and demo usage. The production
 *    bits here are conservative and meant to be used behind a proper reverse proxy
 *    and TLS termination (nginx/Caddy/managed LB). Many of the protections are
 *    enabled only when NODE_ENV === 'production'.
 */

import express from "express";
import http from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
// @ts-ignore: optional dev dependency in the playground dev-server
import * as csurf from "csurf";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { IncomingMessage, ServerResponse } from "http";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createStockAnalytics } from "./analytics/stocks.js";
// @ts-ignore: optional dev dependency in the playground dev-server
import Handlebars from "handlebars";

/**
 * AnalyticsService
 *
 * Lightweight service encapsulating the RxJS pipeline that computes
 * technical indicators for incoming ticks. It exposes:
 *  - pushTick(tick): push a new tick into the pipeline
 *  - metrics$: Observable emitting computed metrics per symbol
 *
 * This keeps analytics as a domain service and avoids sprinkling Subject
 * usage across the rest of the server code.
 */
export class AnalyticsService {
  settings: {
    emaFast: number;
    emaSlow: number;
    rsiPeriod: number;
    bbPeriod: number;
    bbStd: number;
  };
  input: any;
  metrics$: any;

  constructor(opts?: { emaFast?: number; emaSlow?: number; rsiPeriod?: number; bbPeriod?: number; bbStd?: number }) {
    this.settings = {
      emaFast: opts?.emaFast ?? 9,
      emaSlow: opts?.emaSlow ?? 21,
      rsiPeriod: opts?.rsiPeriod ?? 14,
      bbPeriod: opts?.bbPeriod ?? 20,
      bbStd: opts?.bbStd ?? 2,
    };

    // Delegate analytics implementation to the incremental analytics module.
    // createStockAnalytics returns { input: Subject<StockTick>, metrics$: Observable<StockMetrics> }.
    const analytics = createStockAnalytics({
      emaFast: this.settings.emaFast,
      emaSlow: this.settings.emaSlow,
      rsiPeriod: this.settings.rsiPeriod,
      bbPeriod: this.settings.bbPeriod,
      bbStd: this.settings.bbStd,
    });

    // reuse the Subject and metrics$ from the analytics module
    this.input = analytics.input;
    this.metrics$ = analytics.metrics$;
  }

  pushTick(tick: { symbol: string; price: number; change?: number; timestamp: number }) {
    // Defensive: don't let analytics errors bubble into the producer
    try {
      this.input.next(tick);
    } catch {
      // ignore
    }
  }
}

/* -------------------------
   Config / allowed origins
   ------------------------- */

const NODE_ENV = process.env.NODE_ENV || "development";
const DEFAULT_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function getAllowedOrigins(): string[] {
  // If ALLOWED_ORIGINS env var present, use it. Otherwise default to same-origin only (no cross-site).
  if (DEFAULT_ALLOWED_ORIGINS.length > 0) return DEFAULT_ALLOWED_ORIGINS;
  // If not configured, we allow "same-origin" by leaving the list empty and handling it specially.
  return [];
}
const ALLOWED_ORIGINS = getAllowedOrigins();

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
    secure: NODE_ENV === "production",
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

type ServerMsg =
  | { type: "patch"; id: string; html: string; tx?: number; fp?: string }
  | { type: "redirect"; url: string }
  | { type: "event"; name: string; payload?: any };

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

// Analytics service (realtime indicators)
const analytics = new AnalyticsService({ emaFast: 9, emaSlow: 21, rsiPeriod: 14 });

// Subscribe to analytics metrics and broadcast them to connected clients (WS + SSE)
analytics.metrics$.subscribe((m: any) => {
  const payload = { type: "stock:metrics", ...m };
  const text = JSON.stringify(payload);
  // Broadcast to WebSocket clients
  for (const ws of stocksClients) {
    try {
      ws.send(text);
    } catch {}
  }
  // Broadcast to SSE clients
  for (const res of sseClients) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }
});

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

/**
 * Compute a tagged fingerprint for a string.
 *
 * Returns a string in the form "<ALG>:<hex>", where ALG indicates the
 * algorithm used, for example "FNV1A64" or "FNV1A32". The tag helps clients
 * reliably interpret which algorithm produced the fingerprint.
 *
 * Usage:
 *   computeFingerprint(html)                      // default attempts 64-bit, falls back to 32-bit
 *   computeFingerprint(html, { algorithm: 'fnv1a32' })
 */
function computeFingerprint(input: string, opts?: { algorithm?: "fnv1a64" | "fnv1a32" }): string {
  const desired = (opts && opts.algorithm) || "fnv1a64";
  const s = String(input ?? "");

  // Prefer BigInt/TextEncoder path for 64-bit FNV-1a when requested.
  if (desired === "fnv1a64") {
    try {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(s);
      const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
      const FNV_PRIME_64 = 0x100000001b3n;
      let hash = FNV_OFFSET_BASIS_64;
      for (let i = 0; i < bytes.length; i++) {
        hash ^= BigInt(bytes[i]);
        hash = (hash * FNV_PRIME_64) & 0xffffffffffffffffn;
      }
      // Prefix with algorithm tag so clients know how to interpret the fp.
      return "FNV1A64:" + hash.toString(16).padStart(16, "0");
    } catch {
      // If BigInt/TextEncoder isn't available, fall through to 32-bit.
    }
  }

  // 32-bit FNV-1a fallback (deterministic, widely available).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return "FNV1A32:" + (h >>> 0).toString(16).padStart(8, "0");
}

function renderRegionHtmlForId(id: string) {
  // Simple example: return a fragment that the client will use to patch a region.
  // If you need to include inline scripts here, use res.locals.cspNonce when serving via Express.
  return `<div data-region-id="${escapeHtml(id)}">${renderItemsFragment()}</div>`;
}

function broadcastPatch(id: string, html: string, tx?: number) {
  const subs = liveSubscribers.get(id);
  if (!subs) return;
  // Compute a tagged fingerprint for the html fragment so clients can skip redundant swaps.
  // The returned value is prefixed with the algorithm tag, e.g. "FNV1A64:..." or "FNV1A32:...".
  const fp = computeFingerprint(html);
  const msg: ServerMsg = { type: "patch", id, html, tx, fp };
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

// Use Helmet for common security headers. We turn off Helmet's CSP because
// this app uses a per-request nonce-based CSP that is generated below.
app.use(helmet({ contentSecurityPolicy: false }));
app.disable("x-powered-by");

// Allow CORS for development if desired, but the default is permissive here.
// For production, prefer explicit ALLOWED_ORIGINS via env.
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// If running behind a reverse proxy in production, trust the first proxy so that
// req.secure and req.ip behave correctly.
if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
  // Add HSTS header to enforce HTTPS in browsers (only in production)
  app.use((_req, res, next) => {
    // One year, include subdomains, preload directive recommended if you intend to submit to preload list
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    next();
  });
}

/*
  CSRF protection: use cookie-based csurf.
  This will:
    - Populate req.csrfToken() for handlers (GET can call it to provide token)
    - Validate non-GET requests for the token sent via header or body/query param
  The client should send the token in the 'X-CSRF-Token' header (or conventional names).
*/
const csrfProtection = (csurf as unknown as (opts?: any) => express.RequestHandler)({
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    // path: '/', // default
  },
});

// Apply CSRF protection globally for mutating requests. We register it as middleware so
// that GETs still produce a token (req.csrfToken) and non-safe methods are checked.
app.use(csrfProtection);

/* -------------------------
   Per-request CSP + other security headers middleware
   NOTE: This runs after Helmet so we can still set the nonce-aware CSP
   ------------------------- */
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

/* -------------------------
   Helper: origin validation
   ------------------------- */

/**
 * Determines whether the request origin is allowed.
 * Behavior:
 *  - In development (NODE_ENV !== 'production') this allows any origin to simplify local dev.
 *  - In production, if ALLOWED_ORIGINS env var is set (comma-separated list) we only allow those.
 *  - Otherwise we enforce same-origin: origin must match the Host header's scheme+host.
 */
function isOriginAllowed(req: IncomingMessage): boolean {
  if (NODE_ENV !== "production") return true;

  const originHeader = (req.headers.origin || "") as string;
  const refererHeader = (req.headers.referer || "") as string;
  const hostHeader = (req.headers.host || "") as string;

  // If explicit allowed origins are configured, check against them
  if (ALLOWED_ORIGINS.length > 0) {
    const originsToCheck = [];
    if (originHeader) originsToCheck.push(originHeader);
    if (refererHeader) {
      try {
        const u = new URL(refererHeader);
        originsToCheck.push(`${u.protocol}//${u.host}`);
      } catch {}
    }
    for (const o of originsToCheck) {
      if (ALLOWED_ORIGINS.includes(o)) return true;
    }
    return false;
  }

  // otherwise enforce same-origin: origin (if provided) must equal scheme+host
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader);
      // Compare host (including port) to request host header
      if (originUrl.host === hostHeader) return true;
    } catch {}
    return false;
  }

  // If no origin header present, fall back to referer check (some clients include referer instead)
  if (refererHeader) {
    try {
      const refUrl = new URL(refererHeader);
      if (refUrl.host === hostHeader) return true;
    } catch {}
    return false;
  }

  // If neither header is present, deny in production
  return false;
}

/* -------------------------
   Static files and routes (unchanged behavior, with CSRF tokens available)
   ------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

if (!fs.existsSync(publicDir)) {
  console.warn(`Dev server public directory not found: ${publicDir}`);
}

// Prefer convention-based EJS rendering for HTML requests when .ejs templates exist
// (views are served from the public directory). If no .ejs exists for the request,
// fall back to the static HTML + %CSP_NONCE% replacement behavior.
try {
  // Configure express to look for views in the public directory and use EJS if available.
  app.set("views", publicDir);
  app.set("view engine", "ejs");
} catch (e) {
  // If express/ejs isn't available or configuration fails, continue and fall back to static files.
  // This keeps the dev server resilient.
}

app.use((req, res, next) => {
  try {
    const accept = req.headers.accept || "";
    const wantsHtml = req.path === "/" || req.path.endsWith(".html") || accept.includes("text/html");

    if (wantsHtml) {
      // compute the conventional view name: "/" -> "index", "/foo.html" -> "foo"
      const viewName = req.path === "/" ? "index" : req.path.replace(/^\/+/, "").replace(/\.html$/i, "");
      const ejsFile = path.join(publicDir, `${viewName}.ejs`);

      // If a .ejs view exists, render it via Express so templates can use variables and no manual nonce replacement is needed.
      if (fs.existsSync(ejsFile) && fs.statSync(ejsFile).isFile()) {
        // ensure a nonce is available to templates via locals so they can render attributes like nonce="<%= cspNonce %>"
        const nonce = (res.locals as any).cspNonce || crypto.randomBytes(16).toString("base64");
        res.locals = Object.assign(res.locals || {}, { cspNonce: nonce });

        // Render the view. If rendering fails, fall back to static HTML handling below.
        return res.render(viewName, res.locals, (err, html) => {
          if (err || !html) {
            // Rendering failed; fall back to static file replacement below.
            try {
              const targetPath = req.path === "/" ? "index.html" : req.path.replace(/^\/+/, "");
              const filePath = path.join(publicDir, targetPath);
              if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const fallbackNonce = (res.locals as any).cspNonce || crypto.randomBytes(16).toString("base64");
                let fallbackHtml = fs.readFileSync(filePath, "utf8");
                fallbackHtml = fallbackHtml.replace(/%CSP_NONCE%/g, fallbackNonce);
                if (!/meta[^>]*name=(?:'|")csp-nonce(?:'|")/i.test(fallbackHtml)) {
                  fallbackHtml = fallbackHtml.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="csp-nonce" content="${fallbackNonce}">`);
                }
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.send(fallbackHtml);
                return;
              }
            } catch (e2) {
              // ignore and continue to next()
            }
            return next();
          }

          // Ensure nonce meta is present and placeholders are replaced before sending
          if (!/meta[^>]*name=(?:'|")csp-nonce(?:'|")/i.test(html)) {
            html = html.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="csp-nonce" content="${res.locals.cspNonce}">`);
          }
          html = html.replace(/%CSP_NONCE%/g, String(res.locals.cspNonce));

          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.send(html);
        });
      }

      // No .ejs view found — fall back to static HTML with %CSP_NONCE% replacement
      const targetPath = req.path === "/" ? "index.html" : req.path.replace(/^\/+/, "");
      const filePath = path.join(publicDir, targetPath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const nonce = (res.locals as any).cspNonce || crypto.randomBytes(16).toString("base64");
        let html = fs.readFileSync(filePath, "utf8");

        // Replace any explicit placeholder tokens with the nonce.
        // Authors can include %CSP_NONCE% in templates where they need the nonce.
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
    // If any injection or render step fails, let the request fall through to static serving
  }
  next();
});

// Serve other static assets (images, js, css, etc.)
app.use(express.static(publicDir, { extensions: ["html"] }));

/* -------------------------
   Rate limiter for auth endpoints
   ------------------------- */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 6, // limit each IP to 6 login requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many login attempts, try again later." },
});

/* -------------------------
   Public API endpoints
   ------------------------- */

/* -------------------------
   Auth routes (demo)
   - POST /login  -> accepts simple credentials, issues auth cookie (JWT-like HMAC token)
   - POST /logout -> clears auth cookie
   - GET  /me     -> returns authenticated user info
   Note: This is a demo implementation. Replace credential checks with real user store / hashing in production.
   CSRF protection applies (client should fetch /csrf-token and send X-CSRF-Token for POSTs).
   ------------------------- */

app.post("/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  // Demo credential check: accept any non-empty username, and optional simple password check.
  // Replace this with real user lookup and password verification (bcrypt/argon2) in production.
  if (!username || typeof username !== "string" || username.trim() === "") {
    res.status(400).json({ ok: false, error: "username required" });
    return;
  }

  const token = signAuthToken(username, 60 * 60); // 1 hour
  setAuthCookie(res, token, 60 * 60);

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

// REST CRUD endpoints for /api/items
// List
app.get("/api/items", (_req, res) => {
  const list = Object.values(items);
  res.json({ ok: true, items: list });
});

// Get single item
app.get("/api/items/:id", (req, res) => {
  const id = String(req.params.id || "");
  const item = items[id];
  if (!item) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }
  res.json({ ok: true, item });
});

// Create
app.post("/api/items", express.json(), (req, res) => {
  // Accept optional natural/string id via body.id; fallback to numeric generation
  const body = req.body || {};
  const providedId = body.id;
  const { title, score = 0, active = false } = body;

  if (!title || typeof title !== "string") {
    res.status(400).json({ ok: false, error: "title required" });
    return;
  }

  // Determine id: prefer provided natural id (string) when present and non-empty,
  // otherwise generate a next numeric id (simple incremental)
  let id: string | null = null;
  if (typeof providedId !== "undefined" && providedId !== null) {
    // accept numeric or string IDs but store as string
    const asStr = String(providedId).trim();
    if (asStr.length > 0) {
      // Prevent accidental overwrite: if id already exists, return 409
      if (items[asStr]) {
        res.status(409).json({ ok: false, error: "id already exists" });
        return;
      }
      id = asStr;
    }
  }

  if (!id) {
    // Generate next numeric id (simple incremental)
    const numericIds = Object.keys(items)
      .map((k) => Number(k))
      .filter((n) => !Number.isNaN(n));
    const next = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
    id = String(next);
    // ensure no collision with natural ids (rare) - increment until free
    while (items[id]) {
      id = String(Number(id) + 1);
    }
  }

  const item = { id, title: String(title), score: Number(score) || 0, active: !!active };
  items[id] = item;

  // Broadcast a patch/html snapshot so live clients can update
  try {
    const regionHtml = renderItemsFragment();
    broadcastPatch("items-list-1", regionHtml);
  } catch (e) {
    // best-effort
  }

  res.status(201).json({ ok: true, item });
});

// Update (replace/partial accepted)
app.put("/api/items/:id", express.json(), (req, res) => {
  const id = String(req.params.id || "");
  const item = items[id];
  if (!item) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  const { title, score, active } = req.body || {};
  if (title !== undefined) item.title = String(title);
  if (score !== undefined) item.score = Number(score);
  if (active !== undefined) item.active = !!active;

  try {
    const regionHtml = renderItemsFragment();
    broadcastPatch("items-list-1", regionHtml);
  } catch (e) {
    // ignore
  }

  res.json({ ok: true, item: { ...item } });
});

// Delete
app.delete("/api/items/:id", (req, res) => {
  const id = String(req.params.id || "");
  const item = items[id];
  if (!item) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  delete items[id];

  try {
    const regionHtml = renderItemsFragment();
    broadcastPatch("items-list-1", regionHtml);
  } catch (e) {
    // ignore
  }

  res.json({ ok: true });
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
  try {
    const token = (req as any).csrfToken();
    res.json({ ok: true, csrfToken: token });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Unable to generate CSRF token" });
  }
});

/* -------------------------
   CSP report endpoint (collects reports from browsers)
   ------------------------- */

app.post("/csp-report", express.json({ type: ["application/csp-report", "application/json"] }), (req, res) => {
  // Report bodies differ between browsers; we log them and return 204 No Content.
  try {
    const report = req.body;
    // In production you'd forward these to a logging/monitoring backend
    console.warn("CSP violation report:", JSON.stringify(report));
  } catch (e) {
    // ignore parsing errors
  }
  res.status(204).end();
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
    // Include a tagged fingerprint so clients can decide whether to apply the patch.
    // Fingerprints are tagged with the algorithm used (e.g. "FNV1A64:...") so the client
    // runtime can reliably interpret and compare them.
    const fp = computeFingerprint(regionHtml);
    res.json({ ok: true, patch: { id: "items-list-1", html: regionHtml, fp } });
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(regionHtml);
  }
});

/* -------------------------
   Stocks HTTP partial/json endpoint
   ------------------------- */

/**
 * GET /stocks
 *
 * Supports:
 *  - ?partial=rows            -> returns JSON { ok, patch: { id: 'stocks-table', html, fp }, meta }
 *  - Accept: application/json -> same as partial=rows (JSON)
 *  - otherwise returns the table wrapper HTML with rows replaced server-side
 *
 * Query params:
 *  - page, perPage, q  (filter by symbol substring)
 */
app.get("/stocks", (req, res) => {
  // Basic origin check: mirror SSE/WS policy (only relevant in production mode)
  if (NODE_ENV === "production" && !isOriginAllowed(req)) {
    res.status(403).json({ ok: false, error: "origin not allowed" });
    return;
  }

  // Parse query params
  const q = (req.query.q || "") as string;
  const page = Math.max(1, Number((req.query.page as string) || 1));
  const perPage = Math.max(1, Math.min(200, Number((req.query.perPage as string) || 25)));
  const partial = (req.query.partial || "") as string;
  const accept = (req.headers["accept"] || "").toString();

  // Filter & transform pipeline
  const filtered = Object.values(stocks)
    .filter((s) => (q ? s.symbol.toLowerCase().includes(q.toLowerCase()) : true))
    .map((s) => ({
      symbol: s.symbol,
      price: s.price != null ? s.price.toFixed(2) : "—",
      change: s.change != null ? (s.change > 0 ? `+${s.change.toFixed(2)}` : s.change.toFixed(2)) : "—",
      last: new Date(s.timestamp).toLocaleTimeString(),
      timestamp: s.timestamp,
    }));

  const total = filtered.length;
  const offset = (page - 1) * perPage;
  const pageItems = filtered.slice(offset, offset + perPage);

  const meta = {
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
    hasMore: offset + perPage < total,
    query: { q },
  };

  // Render rows using Handlebars rows partial/template (views/partials/stocks/rows.hbs)
  const rowsPath = path.join(__dirname, "..", "views", "partials", "stocks", "rows.hbs");
  let rowsHtml = "";
  try {
    const src = fs.readFileSync(rowsPath, "utf8");
    const tmpl = Handlebars.compile(src);
    rowsHtml = tmpl({ symbols: pageItems, meta });
  } catch (e) {
    // If template read/compile fails, fallback to simple string construction (safe-escaped values)
    rowsHtml = pageItems
      .map(
        (it) =>
          `<tr id="row-${it.symbol}" class="bg-white/3" data-symbol="${it.symbol}" data-ts="${it.timestamp}">` +
          `<td class="py-3"><strong class="font-mono text-white">${escapeHtml(it.symbol)}</strong></td>` +
          `<td class="py-3 font-mono text-slate-200 price" data-price="${escapeHtml(String(it.price))}">${escapeHtml(String(it.price))}</td>` +
          `<td class="py-3 font-mono text-slate-200 change" data-change="${escapeHtml(String(it.change))}">${escapeHtml(String(it.change))}</td>` +
          `<td class="py-3 text-slate-400 font-mono last-updated" data-last="${it.timestamp}">${escapeHtml(it.last)}</td>` +
          `</tr>`,
      )
      .join("");
  }

  // If client expects JSON partial or explicitly asked for partial=rows, return JSON with patch
  if (partial === "rows" || accept.includes("application/json")) {
    const fp = computeFingerprint(rowsHtml);
    res.json({ ok: true, patch: { id: "stocks-table", html: rowsHtml, fp }, meta });
    return;
  }

  // Otherwise return wrapper HTML with rows inserted into the tbody#rows
  try {
    const wrapperPath = path.join(__dirname, "..", "views", "partials", "stocks-table.html");
    let wrapper = fs.readFileSync(wrapperPath, "utf8");
    // Replace the <tbody id="rows">...</tbody> block with our rendered rows. Use a non-greedy match.
    wrapper = wrapper.replace(/<tbody\s+id=["']rows["'][\s\S]*?<\/tbody>/i, `<tbody id="rows" class="divide-y divide-white/5">${rowsHtml}</tbody>`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(wrapper);
  } catch (e) {
    // Fallback: send only rowsHtml if wrapper file missing
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(rowsHtml);
  }
});

/* -------------------------
   Stocks SSE endpoint
   ------------------------- */

app.get("/stocks/sse", (req, res) => {
  // In production, validate Origin/Referer for SSE endpoints to reduce CSRF surface
  if (NODE_ENV === "production" && !isOriginAllowed(req)) {
    res.status(403).json({ ok: false, error: "origin not allowed" });
    return;
  }

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
 *
 * We also validate Origin in production for upgrade requests to reduce
 * cross-site misuse. Browsers include the Origin header for WebSocket upgrades.
 */
httpServer.on("upgrade", function upgrade(request: IncomingMessage, socket, head) {
  const { url } = request;
  if (!url) {
    socket.destroy();
    return;
  }

  // Validate origin in production
  if (NODE_ENV === "production" && !isOriginAllowed(request)) {
    // politely refuse the upgrade
    try {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    } catch {}
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
        if (NODE_ENV !== "production") allowed = true;
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
      // Compute a tagged fingerprint so the client can skip updating if content hasn't changed.
      const fp = computeFingerprint(fragment);
      const reply: ServerMsg = { type: "patch", id: nodeId, html: fragment, fp };
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

  // Feed analytics service with the latest tick for this symbol
  try {
    analytics.pushTick({ symbol: s.symbol, price: s.price, change: s.change, timestamp: s.timestamp });
  } catch (e) {
    // analytics failure should not break the updater loop
  }

  // Broadcast to WS and SSE clients
  broadcastStockUpdate(s);
}, STOCK_UPDATE_INTERVAL);

/* -------------------------
   Start server
   ------------------------- */

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
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

  // Secrets warnings to prompt operator to provide strong secrets in production
  if (JOIN_TOKEN_SECRET === "dev-secret-change-me") {
    console.warn("WARNING: Using default JOIN_TOKEN_SECRET. Set HYPE_JOIN_SECRET in production!");
  }
  if (AUTH_TOKEN_SECRET === "dev-auth-secret-change-me") {
    console.warn("WARNING: Using default AUTH_TOKEN_SECRET. Set AUTH_TOKEN_SECRET in production!");
  }
  if (NODE_ENV === "production" && ALLOWED_ORIGINS.length === 0) {
    console.warn("INFO: Running in production but ALLOWED_ORIGINS is not set. Origin checks will enforce same-origin by default.");
  }
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
