// Bitcoin Core JSON-RPC — the only thing a node operator needs (no -txindex, no Esplora). Modelled on ord's updater:
// blocks are fetched ahead on their own task into a bounded queue, failed calls retry with exponential backoff.
//
// getblock <hash> 3 (Bitcoin Core >= 25.0) returns every input's `prevout` from the node's own undo data, so one call
// per block gives the rules everything they read (the payer of input 0, whether a spent output is a token coin, …).
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import type { Block, Tx, TxIn, TxOut } from "../protocol/types.js";
import { markersOf } from "../protocol/message.js";

export interface RpcOptions {
  url: string;                       // http://127.0.0.1:8332
  username?: string;
  password?: string;
  cookieFile?: string;
  timeoutMs?: number;
  /** most requests in flight at once (ord: --bitcoin-rpc-limit, default 12) */
  limit?: number;
}

const DEFAULT_PORT: Record<string, number> = { mainnet: 8332, bitcoin: 8332, signet: 38332, regtest: 18443 };
/** Bitcoin Core's data dir and the chain's cookie file, as ord resolves them. */
export function defaultCookieFile(chain: string, dataDir?: string): string {
  const base = dataDir ?? (platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Bitcoin")
    : platform() === "win32" ? join(process.env.APPDATA ?? homedir(), "Bitcoin") : join(homedir(), ".bitcoin"));
  return chain === "mainnet" || chain === "bitcoin" ? join(base, ".cookie") : join(base, chain, ".cookie");
}
export const defaultRpcUrl = (chain: string): string => `http://127.0.0.1:${DEFAULT_PORT[chain] ?? 8332}`;

export class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

/** A cookie file Bitcoin Core wrote (`__cookie__:<password>`), or a clear error saying how else to connect. */
export function readCookie(file: string): { user: string; pass: string } {
  let text: string;
  try { text = readFileSync(file, "utf8").trim(); }
  catch (e) {
    throw new RpcError(-1, `cannot read Bitcoin Core's cookie file ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). ` +
      "Is bitcoind running, and can this user read its data directory? Point --bitcoin-data-dir or --cookie-file at it, " +
      "or pass --bitcoin-rpc-username and --bitcoin-rpc-password, or --no-auth for a URL that carries its own key.");
  }
  const i = text.indexOf(":");
  if (i < 0) throw new RpcError(-1, `${file} is not a Bitcoin Core cookie file (expected user:password)`);
  return { user: text.slice(0, i), pass: text.slice(i + 1) };
}

/** `127.0.0.1:8332` → `http://127.0.0.1:8332`; credentials in the URL (`http://user:pass@host`) are taken out of it. */
export function parseRpcUrl(raw: string): { url: string; username?: string; password?: string } {
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); }
  catch { throw new RpcError(-1, `--bitcoin-rpc-url ${raw} is not a URL`); }
  const username = u.username ? decodeURIComponent(u.username) : undefined, password = u.password ? decodeURIComponent(u.password) : undefined;
  u.username = ""; u.password = "";
  return { url: u.toString().replace(/\/$/, (m) => (raw.endsWith("/") ? m : "")), username, password };
}

export class BitcoinRpc {
  private auth: string;
  private url: string;
  private id = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  /**
   * Credentials, as ord chooses them: an explicit username and password; else ones written in the URL; else the
   * cookie file; else none (a hosted endpoint whose URL carries its own access key). With a cookie, a 401 re-reads
   * the file once: Bitcoin Core writes a new cookie every time it restarts.
   */
  constructor(private o: RpcOptions) {
    const p = parseRpcUrl(o.url);
    this.url = p.url;
    if ((o.username === undefined) !== (o.password === undefined)) throw new RpcError(-1, o.username === undefined ? "no Bitcoin RPC username given (--bitcoin-rpc-username)" : "no Bitcoin RPC password given (--bitcoin-rpc-password)");
    this.auth = this.credentials(p);
  }
  private credentials(p = parseRpcUrl(this.o.url)): string {
    const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    if (this.o.username !== undefined) return basic(this.o.username, this.o.password ?? "");
    if (p.username !== undefined) return basic(p.username, p.password ?? "");
    if (this.o.cookieFile) { const c = readCookie(this.o.cookieFile); return basic(c.user, c.pass); }
    return "";
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= (this.o.limit ?? 12)) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      // a hosted node answering 429 (rate limit) is asked again after a pause — slowing down, never failing
      for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
        try { return await fn(); }
        catch (e) { if (!(e instanceof RpcError && e.code === 429)) throw e; await new Promise((r) => setTimeout(r, wait)); }
      }
    } finally { this.active--; this.waiting.shift()?.(); }
  }

  /** One HTTP POST to Bitcoin Core: auth, a re-read cookie after a restart, rate limits and plain errors. */
  private async post(body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await fetch(this.url, {
          method: "POST", headers: { "content-type": "application/json", ...(this.auth ? { authorization: this.auth } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
        });
      } catch (e) {
        // fetch wraps the socket error, sometimes in an AggregateError (one per address tried)
        type Cause = { code?: string; message?: string; errors?: Cause[] };
        const c = (e as { cause?: Cause }).cause;
        const cause = c?.code ?? c?.errors?.find((x) => x.code)?.code ?? c?.message ?? (e as Error).message;
        throw new RpcError(-1, `cannot reach Bitcoin Core at ${this.url} (${cause})`);
      }
      if (r.status === 401) {
        if (attempt === 0 && this.o.cookieFile && this.o.username === undefined) { this.auth = this.credentials(); continue; }
        throw new RpcError(-1, `Bitcoin Core at ${this.url} refused the RPC credentials (HTTP 401): check the cookie file, or --bitcoin-rpc-username and --bitcoin-rpc-password`);
      }
      if (r.status === 403) throw new RpcError(-1, `Bitcoin Core at ${this.url} refused this client (HTTP 403): allow it with -rpcallowip`);
      if (r.status === 429) throw new RpcError(429, "rate limited");
      const j = await r.json().catch(() => null);
      if (j === null) throw new RpcError(-1, `bad RPC response from ${this.url} (HTTP ${r.status})`);
      return j;
    }
  }

  /** Several calls in one HTTP request (JSON-RPC batch); results in the same order. */
  batch<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    return this.slot(async () => {
      const j = (await this.post(calls.map((c, i) => ({ jsonrpc: "1.0", id: i, method: c.method, params: c.params })))) as { id: number; result?: T; error?: { code: number; message: string } }[];
      if (!Array.isArray(j)) throw new RpcError(-1, "bad RPC batch response");
      j.sort((a, b) => a.id - b.id);
      return j.map((x) => { if (x.error) throw new RpcError(x.error.code, x.error.message); return x.result as T; });
    });
  }

  call<T>(method: string, params: unknown[] = []): Promise<T> { return this.slot(() => this.call1<T>(method, params)); }
  private async call1<T>(method: string, params: unknown[]): Promise<T> {
    const j = (await this.post({ jsonrpc: "1.0", id: ++this.id, method, params })) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new RpcError(j.error.code, j.error.message);
    return j.result as T;
  }

  getBlockCount = () => this.call<number>("getblockcount");
  /** null when the height is above the tip (Core error -8) */
  async getBlockHash(height: number): Promise<string | null> {
    try { return await this.call<string>("getblockhash", [height]); }
    catch (e) { if (e instanceof RpcError && e.code === -8) return null; throw e; }
  }
  getBlockHeader = (hash: string) => this.call<{ hash: string; height: number; previousblockhash?: string; time: number }>("getblockheader", [hash, true]);
  async getBlock(hash: string, keys = false): Promise<FetchedBlock> {
    const b = await this.call<CoreBlock>("getblock", [hash, 3]);
    const txs = b.tx.map(toTx);
    return { height: b.height, hash: b.hash, prev: b.previousblockhash ?? null, time: b.time, txs,
      ...(keys ? { taprootKeys: taprootKeysOf(txs.flatMap((t) => t.vout.map((o) => o.scriptpubkey))) } : {}) };
  }
  /** LOOKUP MODE (for a remote node, where a verbosity-3 block is ~4x the bytes): the raw block, parsed here, and
   *  prevouts fetched only for the transactions that carry a CRC-20 marker — the only ones the rules read prevouts of. */
  async getBlockLookup(hash: string, network: bitcoin.Network, height: number, opts: { rest?: string; needAll?: (h: number) => boolean; keys?: boolean } = {}): Promise<FetchedBlock> {
    const raw = opts.rest ? await restBlock(opts.rest, hash) : Buffer.from(await this.call<string>("getblock", [hash, 0]), "hex");
    // 80-byte header: version(4) prev(32) merkle(32) time(4) bits(4) nonce(4)
    const prev = Buffer.from(raw.subarray(4, 36)).reverse().toString("hex"), time = raw.readUInt32LE(68);
    /* PREFILTER: a block with no `"crc-20"` bytes holds no marker, so no rule touches it. When its BTC/USD is also
     * already known (pinned for every height up to a release), nothing in it is needed and it is not parsed at all. */
    const skip = raw.indexOf(MARKER_BYTES) < 0 && !(opts.needAll?.(height) ?? true);
    if (skip && !opts.keys) return { height, hash, prev, time, txs: [] };
    const blk = bitcoin.Block.fromBuffer(raw);
    const taprootKeys = opts.keys ? taprootKeysOf((blk.transactions ?? []).flatMap((t) => t.outs.map((o) => o.script))) : undefined;
    if (skip) return { height, hash, prev, time, txs: [], taprootKeys };
    const txs = (blk.transactions ?? []).map((t, i) => rawToTx(t, i === 0));
    const need = txs.filter((t) => markersOf(t).length > 0);
    // addresses only where the rules read them: the outputs of transactions that carry a marker
    for (const t of need) for (const o of t.vout) { const a = addressOf(Buffer.from(o.scriptpubkey, "hex"), network); if (a) o.scriptpubkey_address = a; }
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      const full = await this.batch<CoreTx>(chunk.map((t) => ({ method: "getrawtransaction", params: [t.txid, 2, hash] })));
      chunk.forEach((t, j) => { const f = full[j]!; t.vin.forEach((v, k) => { const p = f.vin[k]?.prevout; if (p) v.prevout = toOut(p); }); });
    }
    return { height, hash, prev, time, txs, taprootKeys };
  }
  getRawMempool = () => this.call<string[]>("getrawmempool");
  /** a mempool (or, with -txindex, any) transaction, its prevouts included (verbosity 2) — null when unknown */
  async getRawTransaction(txid: string): Promise<Tx | null> {
    try { return toTx(await this.call<CoreTx>("getrawtransaction", [txid, 2])); }
    catch (e) { if (e instanceof RpcError && e.code === -5) return null; throw e; }
  }
  async checkVersion(): Promise<void> {
    const v = await this.call<{ version: number; subversion: string }>("getnetworkinfo");
    if (v.version < 250000) throw new Error(`Bitcoin Core ${v.subversion} is too old: getblock verbosity 3 (prevouts) needs 25.0 or newer.`);
  }
}

/* ── Core JSON -> the shape the core reads (src/core/types.ts) ─────────────────────────────────────────────────────── */

interface CoreSpk { hex: string; address?: string; type: string }
interface CoreOut { value: number; n: number; scriptPubKey: CoreSpk }
interface CoreIn { txid?: string; vout?: number; coinbase?: string; txinwitness?: string[]; sequence: number; prevout?: { value: number; scriptPubKey: CoreSpk } }
interface CoreTx { txid: string; vin: CoreIn[]; vout: CoreOut[] }
interface CoreBlock { hash: string; height: number; previousblockhash?: string; time: number; tx: CoreTx[] }

const TYPE: Record<string, string> = {
  witness_v1_taproot: "v1_p2tr", witness_v0_keyhash: "v0_p2wpkh", witness_v0_scripthash: "v0_p2wsh",
  pubkeyhash: "p2pkh", scripthash: "p2sh", nulldata: "op_return", pubkey: "p2pk", multisig: "multisig",
  anchor: "anchor", witness_unknown: "unknown", nonstandard: "nonstandard",
};
/** BTC (JSON number with at most 8 decimals) -> integer sats. Exact for every valid amount. */
export const toSats = (btc: number): number => Math.round(btc * 1e8);
const toOut = (o: { value: number; scriptPubKey: CoreSpk }): TxOut => ({
  value: toSats(o.value), scriptpubkey: o.scriptPubKey.hex,
  scriptpubkey_type: TYPE[o.scriptPubKey.type] ?? o.scriptPubKey.type,
  ...(o.scriptPubKey.address ? { scriptpubkey_address: o.scriptPubKey.address } : {}),
});
function toTx(t: CoreTx): Tx {
  return {
    txid: t.txid,
    vin: t.vin.map((i): TxIn => i.coinbase !== undefined
      ? { txid: "0".repeat(64), vout: 0xffffffff, witness: i.txinwitness ?? [], prevout: null, sequence: i.sequence, is_coinbase: true }
      : { txid: i.txid!, vout: i.vout!, witness: i.txinwitness ?? [], prevout: i.prevout ? toOut(i.prevout) : null, sequence: i.sequence }),
    vout: t.vout.map(toOut),
  };
}

/** Every CRC-20 marker contains these bytes (`"crc-20"`), so their absence rules a block out without parsing it. */
const MARKER_BYTES = Buffer.from('"crc-20"', "utf8");

/** A raw block from Bitcoin Core's REST interface (bitcoind -rest=1): binary, no JSON or hex — the fastest way to read
 *  blocks from a node short of reading its block files. `base` is e.g. http://127.0.0.1:8332 */
async function restBlock(base: string, hash: string): Promise<Buffer> {
  const r = await fetch(`${base.replace(/\/$/, "")}/rest/block/${hash}.bin`, { signal: AbortSignal.timeout(120_000) });
  if (r.status === 429) throw new RpcError(429, "rate limited");
  if (!r.ok) throw new RpcError(-1, `REST block ${hash}: HTTP ${r.status} (is bitcoind running with -rest=1?)`);
  return Buffer.from(await r.arrayBuffer());
}

/** An output script's address, encoded directly (no curve checks — bitcoinjs's fromOutputScript validates every Taproot
 *  key, which made a full mainnet block cost seconds of CPU). Same strings as Bitcoin Core for every standard type. */
export function addressOf(s: Buffer, network: bitcoin.Network): string | undefined {
  try {
    if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac)
      return bitcoin.address.toBase58Check(s.subarray(3, 23), network.pubKeyHash);
    if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return bitcoin.address.toBase58Check(s.subarray(2, 22), network.scriptHash);
    const v = s[0], len = s[1];
    if (s.length >= 4 && s.length <= 42 && len === s.length - 2 && len >= 2 && len <= 40 && (v === 0x00 || (v! >= 0x51 && v! <= 0x60))) {
      const version = v === 0x00 ? 0 : v! - 0x50;
      if (version === 0 && len !== 20 && len !== 32) return undefined;
      return bitcoin.address.toBech32(s.subarray(2), version, network.bech32);
    }
  } catch { /* not encodable */ }
  return undefined;
}

/** A raw transaction (bitcoinjs) in the shape the core reads; addresses and prevouts are filled in afterwards where needed. */
function rawToTx(t: bitcoin.Transaction, coinbase: boolean): Tx {
  const outType = (s: Buffer): string => s[0] === 0x6a ? "op_return" : s.length === 34 && s[0] === 0x51 && s[1] === 0x20 ? "v1_p2tr"
    : s.length === 22 && s[0] === 0x00 && s[1] === 0x14 ? "v0_p2wpkh" : s.length === 34 && s[0] === 0x00 && s[1] === 0x20 ? "v0_p2wsh" : "other";
  return {
    txid: t.getId(),
    vin: t.ins.map((i): TxIn => ({
      txid: coinbase ? "0".repeat(64) : Buffer.from(i.hash).reverse().toString("hex"), vout: coinbase ? 0xffffffff : i.index,
      witness: (i.witness ?? []).map((w) => Buffer.from(w).toString("hex")), prevout: null, sequence: i.sequence, ...(coinbase ? { is_coinbase: true } : {}),
    })),
    vout: t.outs.map((o): TxOut => {
      const script = Buffer.from(o.script);
      return { value: Number(o.value), scriptpubkey: script.toString("hex"), scriptpubkey_type: outType(script) };
    }),
  };
}

/* ── block fetcher: runs ahead of the indexer, bounded, with retries ───────────────────────────────────────────────── */

/** `taprootKeys`: every distinct Taproot output key in the block (all transactions), for owner linking — not consensus */
export interface FetchedBlock extends Block { prev: string | null; time: number; taprootKeys?: string[] }
const taprootKeysOf = (scripts: Iterable<Uint8Array | string>): string[] => {
  const keys = new Set<string>();
  for (const s of scripts) {
    if (typeof s === "string") { if (s.length === 68 && s.startsWith("5120")) keys.add(s.slice(4)); }
    else if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) keys.add(Buffer.from(s.subarray(2)).toString("hex"));
  }
  return [...keys];
};

/** Blocks from `from` up to the tip (or `limit`), in order. Like ord: up to `ahead` blocks are fetched before they are
 *  consumed; a failing call retries after 1, 2, 4 … s and gives up beyond 120 s. Below `firstBlock` only the header is
 *  read (no transactions), which is all reorg detection needs. */
export interface FetchOptions {
  firstBlock: number; limit?: number; ahead?: number; log?: (m: string) => void;
  /** raw blocks parsed here, prevouts looked up for marker transactions only */
  lookup?: bitcoin.Network;
  /** read raw blocks from Bitcoin Core's REST interface at this base URL (implies lookup) */
  rest?: string;
  /** must every transaction of block h be parsed (its BTC/USD is not known yet)? */
  needAll?: (h: number) => boolean;
  /** also list every block's Taproot output keys (owner linking) */
  keys?: boolean;
}
export async function* fetchBlocks(rpc: BitcoinRpc, from: number, opts: FetchOptions): AsyncGenerator<FetchedBlock> {
  const ahead = opts.ahead ?? 32;
  const queue: Promise<FetchedBlock | null>[] = [];
  let next = from;
  const one = (h: number) => withRetries(async () => {
    const hash = await rpc.getBlockHash(h);
    if (!hash) return null;
    if (h < opts.firstBlock) {
      const hd = await rpc.getBlockHeader(hash);
      return { height: h, hash, prev: hd.previousblockhash ?? null, time: hd.time, txs: [] };
    }
    return opts.lookup ? rpc.getBlockLookup(hash, opts.lookup, h, { rest: opts.rest, needAll: opts.needAll, keys: opts.keys }) : rpc.getBlock(hash, opts.keys);
  }, opts.log, h).catch((e) => { throw e; });
  const fill = () => { while (queue.length < ahead && (opts.limit === undefined || next < opts.limit)) queue.push(one(next++)); };
  fill();
  try {
    while (queue.length) {
      const b = await queue.shift()!;
      if (!b) return;                                 // reached the tip
      yield b;
      fill();
    }
  } finally {
    // blocks fetched ahead and never consumed (tip reached, a reorg, or a stop): their results, or failures, are dropped
    for (const p of queue) p.catch(() => {});
  }
}

async function withRetries<T>(fn: () => Promise<T>, log: ((m: string) => void) | undefined, height: number): Promise<T> {
  for (let errors = 1; ; errors++) {
    try { return await fn(); }
    catch (e) {
      const s = 2 ** (errors - 1);
      if (s > 120) throw e;
      log?.(`block ${height}: ${(e as Error).message} — retrying in ${s}s`);
      await new Promise((r) => setTimeout(r, s * 1000));
    }
  }
}
