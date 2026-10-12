// The /v1 JSON API (docs/API.md) plus ord-compatible routes. Plain node:http, no framework.
// It reads the ledger through its own read-only connection, so a response only ever sees committed blocks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Ctx } from "../protocol/context.js";
import * as Q from "./query.js";
import { all, getBlockHash, getCursor } from "../store/ledger.js";
import type { BitcoinRpc } from "../index/fetcher.js";
import { type Mempool, candidateTx, simulateAll, spendingInMempool, verdict } from "./live.js";
import { buildMerge, buildTransfer } from "./build.js";

export interface ApiOptions { port: number; host?: string; version: string; pinned: Record<string, string>; chainTip: () => number | null;
  /** the ledger file (simulations open their own connection to it and roll back) */
  dbPath: string; rpc: BitcoinRpc | null; mempool: Mempool | null }

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
  const wantPending = (q: URLSearchParams) => !!o.mempool && q.get("mempool") !== "0";
  /** coins of these covenants that a pending transaction spends: CRC-20 ones from the overlay, any other from Core */
  const pendingSpends = async (covs: string[]) => {
    const ph = covs.map(() => "?").join(",");
    const ops = covs.length ? all<{ outpoint: string }>(c.db, `SELECT outpoint FROM seals WHERE status = 'active' AND owner_address IN (${ph})`, ...covs).map((r) => r.outpoint) : [];
    const m = new Map<string, string>();
    for (const op of ops) { const t = o.mempool!.spentBy.get(op); if (t) m.set(op, t); }
    if (o.rpc) for (const [op, t] of await spendingInMempool(o.rpc, ops.filter((x) => !m.has(x)))) m.set(op, t);
    return m;
  };
  const pendingSpentSet = async (from: string | undefined, publicKey: string | undefined) => {
    if (!o.mempool || !from) return new Set<string>();
    try { const r = Q.resolve(c, from, publicKey); return new Set((await pendingSpends([...new Set(r.covenants.map((x) => x.covenant))])).keys()); } catch { return new Set<string>(); }
  };
  const routes: [string, RegExp, Handler][] = [
    // ── /v1 ──
    ["GET", /^\/v1\/status$/, () => Q.statusOf(c, o.chainTip(), o.version, o.pinned)],
    ["GET", /^\/v1\/rules$/, () => Q.rules(c)],
    ["GET", /^\/v1\/tokens$/, () => ({ items: Q.tokenRows(c).map((d) => Q.tokenSummary(c, d)), next_cursor: null })],
    ["GET", /^\/v1\/tokens\/([A-Za-z0-9]{2,8})$/, (_c, m) => Q.tokenDetail(c, m[1]!)],
    ["GET", /^\/v1\/tokens\/([A-Za-z0-9]{2,8})\/holders$/, (_c, m, q) => Q.holders(c, m[1]!, page(q), cursor(q) ?? 0, q.get("include") === "coins")],
    ["GET", /^\/v1\/tokens\/([A-Za-z0-9]{2,8})\/activity$/, (_c, m, q) => Q.tokenActivity(c, m[1]!, page(q), cursor(q))],
    ["GET", /^\/v1\/addresses\/([^/]+)\/balances$/, async (_c, m, q) => {
      const r = resolved(m, q), b = Q.balances(c, r);
      if (!wantPending(q)) return b;
      const covs = new Set(r.covenants.map((x) => x.covenant)), spends = await pendingSpends([...covs]), arriving = o.mempool!.arriving(covs);
      const coinsOf = new Map(all<{ outpoint: string; owner_address: string; tick: string; amount_atoms: string }>(c.db,
        `SELECT outpoint, owner_address, tick, amount_atoms FROM seals WHERE outpoint IN (${[...spends.keys()].map(() => "?").join(",") || "''"})`, ...spends.keys()).map((x) => [x.outpoint, x]));
      const items = r.covenants.map((cv) => {
        const base = b.items.find((x) => x.tick === cv.tick && x.covenant === cv.covenant);
        const out = [...coinsOf.values()].filter((x) => x.owner_address === cv.covenant && x.tick === cv.tick).reduce((a, x) => a + BigInt(x.amount_atoms), 0n);
        const inn = arriving.filter((x) => x.covenant === cv.covenant && x.tick === cv.tick).reduce((a, x) => a + BigInt(x.amount), 0n);
        const conf = BigInt(base?.confirmed ?? "0");
        return { tick: cv.tick, decimals: 8, covenant: cv.covenant, confirmed: conf.toString(), coins: base?.coins ?? 0,
          pending_in: inn.toString(), pending_out: out.toString(), available: (conf - out).toString() };
      }).filter((x) => r.kind === "covenant" || x.confirmed !== "0" || x.pending_in !== "0");
      return { ...b, items, mempool: { txs: o.mempool!.size, updated_at: o.mempool!.updatedAt } };
    }],
    ["GET", /^\/v1\/addresses\/([^/]+)\/coins$/, async (_c, m, q) => {
      const r = resolved(m, q), res = Q.coins(c, r, q.get("tick") ?? undefined);
      if (!wantPending(q)) return res;
      const spends = await pendingSpends([...new Set(r.covenants.map((x) => x.covenant))]);
      const covs = new Set(r.covenants.map((x) => x.covenant));
      return { items: res.items.map((x) => ({ ...x, pending_spent_by: spends.get(x.outpoint) ?? null })),
        arriving: o.mempool!.arriving(covs).filter((x) => !q.get("tick") || x.tick === q.get("tick")!.toUpperCase()) };
    }],
    ["GET", /^\/v1\/addresses\/([^/]+)\/covenants$/, (_c, m, q) => Q.covenants(c, resolved(m, q))],
    ["GET", /^\/v1\/addresses\/([^/]+)\/activity$/, (_c, m, q) => Q.addressActivity(c, resolved(m, q), page(q), cursor(q), q.get("tick") ?? undefined)],
    ["GET", /^\/v1\/addresses\/([^/]+)\/protected-outputs$/, (_c, m) => Q.protectedOutputs(c, decodeURIComponent(m[1]!))],
    ["GET", /^\/v1\/outputs\/([0-9a-f]{64}:\d+)$/, (_c, m) => Q.output(c, m[1]!)],
    ["POST", /^\/v1\/outputs\/check$/, async (_c, _m, _q, body) => {
      const b = (await body()) as { outpoints?: unknown };
      if (!Array.isArray(b.outpoints) || b.outpoints.length > 1000) throw new Q.ApiError(400, "bad_request", "Send {\"outpoints\": [\"txid:vout\", …]} (at most 1000).");
      return { items: b.outpoints.map((op) => { const r = Q.output(c, String(op)); return { outpoint: r.outpoint, token: r.token && { tick: r.token.tick, amount: r.token.amount, status: r.token.status } }; }) };
    }],
    ["GET", /^\/v1\/transactions\/([0-9a-f]{64})$/, (_c, m) => {
      try { return Q.transaction(c, m[1]!); }
      catch (e) {
        // not in a block yet: what it does if it confirms next
        const eff = o.mempool?.effects.find((x) => x.txid === m[1]);
        if (eff) return { ...eff, pending: true };
        throw e;
      }
    }],
    ["POST", /^\/v1\/transactions\/simulate$/, async (_c, _m, _q, body) => {
      const b = (await body()) as { tx_hex?: string; psbt_base64?: string };
      const { tx, unsigned } = await candidateTx(c.db, o.rpc, c.btc, b);
      // on top of everything pending: the candidate is judged against the ledger as it will be
      const pending = (o.mempool?.pendingTxs() ?? []).filter((t) => t.txid !== tx.txid);
      const effs = simulateAll(o.dbPath, c.net, [...pending, tx]);
      return { ...verdict(c.db, tx, effs[effs.length - 1]!, unsigned), on_top_of_pending: pending.length };
    }],
    ["POST", /^\/v1\/build\/transfer$/, async (_c, _m, _q, body) => {
      const b = (await body()) as Parameters<typeof buildTransfer>[1];
      const r = buildTransfer(c, b, await pendingSpentSet(b.from, b.public_key));
      const { tx, unsigned } = await candidateTx(c.db, o.rpc, c.btc, { psbt_base64: r.psbt_base64 });
      const effs = simulateAll(o.dbPath, c.net, [...(o.mempool?.pendingTxs() ?? []), tx]);
      return { ...r, simulation: verdict(c.db, tx, effs[effs.length - 1]!, unsigned) };
    }],
    ["POST", /^\/v1\/build\/merge$/, async (_c, _m, _q, body) => {
      const b = (await body()) as Parameters<typeof buildMerge>[1];
      const r = buildMerge(c, b, await pendingSpentSet(b.from, b.public_key));
      const { tx, unsigned } = await candidateTx(c.db, o.rpc, c.btc, { psbt_base64: r.psbt_base64 });
      const effs = simulateAll(o.dbPath, c.net, [...(o.mempool?.pendingTxs() ?? []), tx]);
      return { ...r, simulation: verdict(c.db, tx, effs[effs.length - 1]!, unsigned) };
    }],
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

  /* LIVE EVENTS (server-sent events): every balance change as its block is indexed, each new block, a `reorg` with the
   * fork height when blocks are rolled back, and the pending CRC-20 transactions as the mempool changes. ?from_id=N
   * replays everything after event N first, so a client that reconnects misses nothing. */
  const clients = new Set<{ res: ServerResponse; lastId: number; tick: string | null }>();
  let lastHeight = (getCursor(c.db) ?? 1) - 1, lastHash = getBlockHash(c.db, lastHeight), lastPending = "";
  const send = (res: ServerResponse, event: string, data: unknown, id?: number) =>
    res.write(`${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
  const pushEvents = (cl: { res: ServerResponse; lastId: number; tick: string | null }) => {
    for (;;) {
      const page = Q.events(c, 0, 1e9, cl.tick ?? undefined, 500, cl.lastId);
      for (const e of page.items) { send(cl.res, "event", e, e.index); cl.lastId = e.index; }
      if (!page.next_cursor) break;
    }
  };
  function stream(_req: IncomingMessage, res: ServerResponse, q: URLSearchParams) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "access-control-allow-origin": "*" });
    const fromId = q.get("from_id") != null ? Number(q.get("from_id")) : (all<{ id: number | null }>(c.db, "SELECT MAX(id) id FROM deltas")[0]?.id ?? 0);
    const cl = { res, lastId: fromId, tick: q.get("tick") ? q.get("tick")!.toUpperCase() : null };
    clients.add(cl);
    send(res, "hello", { indexed_height: lastHeight, indexed_hash: lastHash, from_id: fromId });
    pushEvents(cl);
    _req.on("close", () => clients.delete(cl));
  }
  setInterval(() => {
    try {
      const h = (getCursor(c.db) ?? 1) - 1;
      const stillThere = getBlockHash(c.db, lastHeight);
      if (h < lastHeight || (stillThere !== null && stillThere !== lastHash)) {
        for (const cl of clients) { send(cl.res, "reorg", { fork_height: Math.min(h, lastHeight) + 1 }); cl.lastId = Math.min(cl.lastId, all<{ id: number | null }>(c.db, "SELECT MAX(id) id FROM deltas")[0]?.id ?? 0); }
      }
      if (h !== lastHeight || getBlockHash(c.db, h) !== lastHash) {
        for (const cl of clients) { pushEvents(cl); send(cl.res, "block", { height: h, hash: getBlockHash(c.db, h) }); }
        lastHeight = h; lastHash = getBlockHash(c.db, h);
      }
      if (o.mempool) {
        const key = o.mempool.effects.map((e) => e.txid).join(",");
        if (key !== lastPending) { lastPending = key; for (const cl of clients) send(cl.res, "pending", { txs: o.mempool.effects }); }
      }
      for (const cl of clients) cl.res.write(": keep-alive\n\n");
    } catch { /* the next tick tries again */ }
  }, 2000).unref();

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 204, null);
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/v1/events/stream") return stream(req, res, url.searchParams);
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
