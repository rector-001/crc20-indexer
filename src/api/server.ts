// The /v1 JSON API (docs/API.md) plus ord-compatible routes. Plain node:http, no framework.
// It reads the ledger through its own read-only connection, so a response only ever sees committed blocks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Ctx } from "../protocol/context.js";
import * as Q from "./query.js";

export interface ApiOptions { port: number; host?: string; version: string; pinned: Record<string, string>; chainTip: () => number | null }

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v === Infinity ? null : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store" });
  res.end(text);
};
const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((ok, fail) => {
  let s = ""; req.on("data", (d) => { s += d; if (s.length > 1_000_000) { fail(new Q.ApiError(413, "too_large", "Body over 1 MB.")); req.destroy(); } });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { fail(new Q.ApiError(400, "bad_json", "The body is not JSON.")); } });
});
const intParam = (v: string | null, d: number, max: number) => { const n = v == null ? d : Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : d; };

type Handler = (c: Ctx, m: RegExpMatchArray, q: URLSearchParams, body: () => Promise<unknown>) => unknown | Promise<unknown>;

export function startApi(c: Ctx, o: ApiOptions) {
  const page = (q: URLSearchParams) => intParam(q.get("limit"), 50, 500);
  const cursor = (q: URLSearchParams) => (q.get("cursor") ? Number(q.get("cursor")) : null);
  const resolved = (m: RegExpMatchArray, q: URLSearchParams) => Q.resolve(c, decodeURIComponent(m[1]!), q.get("public_key"));
  const routes: [string, RegExp, Handler][] = [
    // ── /v1 ──
    ["GET", /^\/v1\/status$/, () => Q.statusOf(c, o.chainTip(), o.version, o.pinned)],
    ["GET", /^\/v1\/rules$/, () => Q.rules(c)],
    ["GET", /^\/v1\/tokens$/, () => ({ items: Q.tokenRows(c).map((d) => Q.tokenSummary(c, d)), next_cursor: null })],
    ["GET", /^\/v1\/tokens\/([A-Za-z0-9]{2,8})$/, (_c, m) => Q.tokenDetail(c, m[1]!)],
    ["GET", /^\/v1\/tokens\/([A-Za-z0-9]{2,8})\/holders$/, (_c, m, q) => Q.holders(c, m[1]!, page(q), cursor(q) ?? 0, q.get("include") === "coins")],
    ["GET", /^\/v1\/tokens\/([A-Za-z0-9]{2,8})\/activity$/, (_c, m, q) => Q.tokenActivity(c, m[1]!, page(q), cursor(q))],
    ["GET", /^\/v1\/addresses\/([^/]+)\/balances$/, (_c, m, q) => Q.balances(c, resolved(m, q))],
    ["GET", /^\/v1\/addresses\/([^/]+)\/coins$/, (_c, m, q) => Q.coins(c, resolved(m, q), q.get("tick") ?? undefined)],
    ["GET", /^\/v1\/addresses\/([^/]+)\/covenants$/, (_c, m, q) => Q.covenants(c, resolved(m, q))],
    ["GET", /^\/v1\/addresses\/([^/]+)\/activity$/, (_c, m, q) => Q.addressActivity(c, resolved(m, q), page(q), cursor(q), q.get("tick") ?? undefined)],
    ["GET", /^\/v1\/addresses\/([^/]+)\/protected-outputs$/, (_c, m) => Q.protectedOutputs(c, decodeURIComponent(m[1]!))],
    ["GET", /^\/v1\/outputs\/([0-9a-f]{64}:\d+)$/, (_c, m) => Q.output(c, m[1]!)],
    ["POST", /^\/v1\/outputs\/check$/, async (_c, _m, _q, body) => {
      const b = (await body()) as { outpoints?: unknown };
      if (!Array.isArray(b.outpoints) || b.outpoints.length > 1000) throw new Q.ApiError(400, "bad_request", "Send {\"outpoints\": [\"txid:vout\", …]} (at most 1000).");
      return { items: b.outpoints.map((op) => { const r = Q.output(c, String(op)); return { outpoint: r.outpoint, token: r.token && { tick: r.token.tick, amount: r.token.amount, status: r.token.status } }; }) };
    }],
    ["GET", /^\/v1\/transactions\/([0-9a-f]{64})$/, (_c, m) => Q.transaction(c, m[1]!)],
    ["GET", /^\/v1\/blocks\/(\d+)$/, (_c, m) => Q.block(c, Number(m[1]))],
    ["GET", /^\/v1\/events$/, (_c, _m, q) => Q.events(c, intParam(q.get("from_height"), 0, 1e9), intParam(q.get("to_height"), 1e9, 1e9), q.get("tick") ?? undefined, page(q), cursor(q))],
    // ── ord-compatible ──
    ["GET", /^\/status$/, () => Q.statusOf(c, o.chainTip(), o.version, o.pinned)],
    ["GET", /^\/(blockcount|blockheight)$/, () => Q.statusOf(c, null, o.version, o.pinned).indexed_height],
    ["GET", /^\/blockhash$/, () => Q.statusOf(c, null, o.version, o.pinned).indexed_hash],
    ["GET", /^\/blockhash\/(\d+)$/, (_c, m) => Q.block(c, Number(m[1])).hash],
    ["GET", /^\/output\/([0-9a-f]{64}:\d+)$/, (_c, m) => { const r = Q.output(c, m[1]!); return { outpoint: r.outpoint, crc20: r.token, spent: r.token ? r.token.status !== "active" : null }; }],
    ["POST", /^\/outputs$/, async (_c, _m, _q, body) => {
      const b = (await body()) as unknown;
      if (!Array.isArray(b) || b.length > 1000) throw new Q.ApiError(400, "bad_request", "Send a JSON array of outpoints (at most 1000).");
      return b.map((op) => { const r = Q.output(c, String(op)); return { outpoint: r.outpoint, crc20: r.token }; });
    }],
    // ord's ?type=cardinal needs every BTC output of the address (ord: --index-addresses); this node lists token coins only
    ["GET", /^\/outputs\/([^/]+)$/, (_c, m, q) => {
      const type = q.get("type") ?? "crc20";
      if (type !== "crc20" && type !== "any") throw new Q.ApiError(400, "unsupported", "This node indexes CRC-20 coins only: use ?type=crc20 (or /v1/addresses/{address}/protected-outputs).");
      return Q.protectedOutputs(c, decodeURIComponent(m[1]!)).items.map((x) => x.outpoint);
    }],
    ["GET", /^\/tx\/([0-9a-f]{64})$/, (_c, m) => Q.transaction(c, m[1]!)],
  ];

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 204, null);
      const url = new URL(req.url ?? "/", "http://x");
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return json(res, 200, await h(c, m, url.searchParams, () => readBody(req)));
      }
      throw new Q.ApiError(404, "not_found", "No such route — see docs/API.md.");
    } catch (e) {
      if (e instanceof Q.ApiError) return json(res, e.status, { error: { code: e.code, message: e.message } });
      json(res, 500, { error: { code: "internal", message: "The node could not answer this request." } });
      console.error(e);
    }
  });
  server.listen(o.port, o.host ?? "127.0.0.1");
  return server;
}
