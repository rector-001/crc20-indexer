// Bitcoin Core JSON-RPC — the only thing a node operator needs (no -txindex, no Esplora). Modelled on ord's updater:
// blocks are fetched ahead on their own task into a bounded queue, failed calls retry with exponential backoff.
//
// getblock <hash> 3 (Bitcoin Core >= 25.0) returns every input's `prevout` from the node's own undo data, so one call
// per block gives the rules everything they read (the payer of input 0, whether a spent output is a token coin, …).
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Block, Tx, TxIn, TxOut } from "../protocol/types.js";

export interface RpcOptions {
  url: string;                       // http://127.0.0.1:8332
  username?: string;
  password?: string;
  cookieFile?: string;
  timeoutMs?: number;
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

export class BitcoinRpc {
  private auth: string;
  private id = 0;
  constructor(private o: RpcOptions) {
    let user = o.username, pass = o.password;
    if (!user && o.cookieFile) [user, pass] = readFileSync(o.cookieFile, "utf8").trim().split(":") as [string, string];
    this.auth = "Basic " + Buffer.from(`${user ?? ""}:${pass ?? ""}`).toString("base64");
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const r = await fetch(this.o.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.auth },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
    });
    if (r.status === 401) throw new RpcError(-1, "Bitcoin Core refused the RPC credentials (check --cookie-file or --bitcoin-rpc-username/password)");
    const j = (await r.json().catch(() => null)) as { result?: T; error?: { code: number; message: string } } | null;
    if (!j) throw new RpcError(-1, `bad RPC response (HTTP ${r.status})`);
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
  async getBlock(hash: string): Promise<Block & { prev: string | null; time: number }> {
    const b = await this.call<CoreBlock>("getblock", [hash, 3]);
    return { height: b.height, hash: b.hash, prev: b.previousblockhash ?? null, time: b.time, txs: b.tx.map(toTx) };
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

/* ── block fetcher: runs ahead of the indexer, bounded, with retries ───────────────────────────────────────────────── */

export interface FetchedBlock extends Block { prev: string | null; time: number }

/** Blocks from `from` up to the tip (or `limit`), in order. Like ord: up to `ahead` blocks are fetched before they are
 *  consumed; a failing call retries after 1, 2, 4 … s and gives up beyond 120 s. Below `firstBlock` only the header is
 *  read (no transactions), which is all reorg detection needs. */
export async function* fetchBlocks(rpc: BitcoinRpc, from: number, opts: { firstBlock: number; limit?: number; ahead?: number; log?: (m: string) => void }): AsyncGenerator<FetchedBlock> {
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
    return rpc.getBlock(hash);
  }, opts.log, h);
  const fill = () => { while (queue.length < ahead && (opts.limit === undefined || next < opts.limit)) queue.push(one(next++)); };
  fill();
  while (queue.length) {
    const b = await queue.shift()!;
    if (!b) return;                                   // reached the tip
    yield b;
    fill();
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
