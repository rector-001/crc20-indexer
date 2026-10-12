// What the ledger WOULD look like: the same rules run over transactions that are not in a block yet — the mempool
// overlay (pending balances) and POST /v1/transactions/simulate. Nothing here is ever written: every run happens inside
// a transaction on its own connection and is rolled back.
import * as bitcoin from "bitcoinjs-lib";
import { DatabaseSync } from "node:sqlite";
import { all, getCursor, lastOracleAtOrBelow, one, type Db } from "../store/ledger.js";
import { makeCtx, type Ctx } from "../protocol/context.js";
import { applyTx } from "../protocol/dispatch.js";
import { markersOf } from "../protocol/message.js";
import type { Tx, TxOut } from "../protocol/types.js";
import type { NetworkConstants } from "../protocol/constants/index.js";
import { addressOf, type BitcoinRpc } from "../index/fetcher.js";
import { ApiError } from "./query.js";

export interface Effects {
  txid: string;
  spent: { outpoint: string; tick: string; amount: string; covenant: string }[];
  created: { outpoint: string; tick: string; amount: string; covenant: string; kind: string }[];
  events: { op: string; tick: string; from: string | null; to: string | null; amount: string }[];
}

/** Run `txs` in order on top of the ledger, collect what each one did, and roll everything back. */
export function simulateAll(dbPath: string, net: NetworkConstants, txs: Tx[]): Effects[] {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 0;");
  try {
    try { db.exec("BEGIN IMMEDIATE"); }
    catch { throw new ApiError(503, "busy", "The node is writing a batch of blocks (initial sync); try again in a moment."); }
    try {
      const c = makeCtx(db, net);
      const tip = (getCursor(db) ?? net.deployBlock) - 1, height = tip + 1;
      const btcUsd = lastOracleAtOrBelow(db, tip) ?? "0";        // the next block's price is not known yet: the last one
      return txs.map((t) => {
        const before = one<{ id: number | null }>(db, "SELECT MAX(id) id FROM deltas")!.id ?? 0;
        applyTx(c, t, height, btcUsd);
        return {
          txid: t.txid,
          spent: all<{ outpoint: string; tick: string; amount_atoms: string; owner_address: string }>(db, "SELECT outpoint, tick, amount_atoms, owner_address FROM seals WHERE spent_txid = ?", t.txid)
            .map((s) => ({ outpoint: s.outpoint, tick: s.tick, amount: s.amount_atoms, covenant: s.owner_address })),
          created: all<{ outpoint: string; tick: string; amount_atoms: string; owner_address: string; kind: string }>(db, "SELECT outpoint, tick, amount_atoms, owner_address, kind FROM seals WHERE txid = ?", t.txid)
            .map((s) => ({ outpoint: s.outpoint, tick: s.tick, amount: s.amount_atoms, covenant: s.owner_address, kind: s.kind })),
          events: all<{ op: string; from_addr: string | null; to_addr: string | null; atoms: string }>(db,
            "SELECT op, from_addr, to_addr, atoms FROM deltas WHERE id > ? AND op NOT LIKE 'raise:%' ORDER BY id", before)
            .map((d) => ({ op: d.op.split(":")[0]!, tick: d.op.split(":")[1]!, from: d.from_addr, to: d.to_addr, amount: d.atoms })),
        };
      });
    } finally { db.exec("ROLLBACK"); }
  } finally { db.close(); }
}

/** Parents before children: a transaction spending another pending transaction's output comes after it. */
export function orderPending(txs: Tx[]): Tx[] {
  const ids = new Map(txs.map((t) => [t.txid, t])), done = new Set<string>(), out: Tx[] = [];
  const visit = (t: Tx, seen: Set<string>) => {
    if (done.has(t.txid) || seen.has(t.txid)) return;
    seen.add(t.txid);
    for (const v of t.vin) { const p = ids.get(v.txid); if (p) visit(p, seen); }
    done.add(t.txid); out.push(t);
  };
  for (const t of txs) visit(t, new Set());
  return out;
}

/* ── the mempool overlay ──────────────────────────────────────────────────────────────────────────────────────────── */

const MARKER_HEX = Buffer.from('"crc-20"', "utf8").toString("hex");

export class Mempool {
  /** txid -> its transaction, for every pending transaction that carries a CRC-20 marker */
  private marked = new Map<string, Tx>();
  /** txids already looked at (with or without a marker) */
  private seen = new Set<string>();
  effects: Effects[] = [];
  /** outpoint -> pending txid that spends it (from the CRC-20 transactions) */
  spentBy = new Map<string, string>();
  updatedAt = 0;
  size = 0;
  constructor(private rpc: BitcoinRpc, private dbPath: string, private net: NetworkConstants, private log: (m: string) => void) {}

  /** One poll: new pending transactions are checked for a marker (raw bytes first), then the overlay is rebuilt. */
  async refresh() {
    const txids = await this.rpc.getRawMempool();
    const now = new Set(txids);
    this.size = txids.length;
    for (const id of [...this.seen]) if (!now.has(id)) { this.seen.delete(id); this.marked.delete(id); }
    const fresh = txids.filter((id) => !this.seen.has(id));
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500);
      const hexes = await this.rpc.batch<string | null>(chunk.map((id) => ({ method: "getrawtransaction", params: [id, 0] }))).catch(() => chunk.map(() => null));
      const withMarker = chunk.filter((_id, j) => typeof hexes[j] === "string" && (hexes[j] as string).includes(MARKER_HEX));
      for (const id of chunk) this.seen.add(id);
      for (const id of withMarker) {
        const t = await this.rpc.getRawTransaction(id).catch(() => null);      // verbosity 2: prevouts included
        if (t && markersOf(t).length) this.marked.set(id, t);
      }
    }
    try {
      this.effects = simulateAll(this.dbPath, this.net, orderPending([...this.marked.values()]));
      this.spentBy = new Map(this.effects.flatMap((e) => e.spent.map((s) => [s.outpoint, e.txid] as [string, string])));
      this.updatedAt = Date.now();
    } catch (e) { if (!(e instanceof ApiError)) this.log(`mempool overlay: ${(e as Error).message}`); }
  }
  pendingTxs(): Tx[] { return orderPending([...this.marked.values()]); }
  /** pending coins arriving at these covenants */
  arriving(covenants: Set<string>) { return this.effects.flatMap((e) => e.created.filter((c) => covenants.has(c.covenant)).map((c) => ({ ...c, txid: e.txid }))); }
}

/** Which of these confirmed coins does ANY mempool transaction spend (also ones without a marker — tokens about to be lost)? */
export async function spendingInMempool(rpc: BitcoinRpc, outpoints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!outpoints.length) return out;
  const r = await rpc.call<{ txid: string; vout: number; spendingtxid?: string }[]>("gettxspendingprevout",
    [outpoints.map((op) => { const [txid, vout] = op.split(":"); return { txid, vout: Number(vout) }; })]).catch(() => []);
  for (const x of r) if (x.spendingtxid) out.set(`${x.txid}:${x.vout}`, x.spendingtxid);
  return out;
}

/* ── a candidate transaction from a wallet: hex or PSBT, signed or not ────────────────────────────────────────────── */

/** Build the core's view of a candidate transaction. Prevouts come from the PSBT, else the ledger's own coins, else
 *  Bitcoin Core's UTXO set (gettxout, mempool included). An unsigned covenant input gets a stand-in witness built from
 *  its PSBT tapLeafScript, so the rules see the leaf it will reveal. */
export async function candidateTx(db: Db, rpc: BitcoinRpc | null, network: bitcoin.Network, body: { tx_hex?: string; psbt_base64?: string }): Promise<{ tx: Tx; unsigned: boolean }> {
  let raw: bitcoin.Transaction, psbt: bitcoin.Psbt | null = null;
  try {
    if (body.psbt_base64) { psbt = bitcoin.Psbt.fromBase64(body.psbt_base64, { network }); raw = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer()); }
    else if (body.tx_hex) raw = bitcoin.Transaction.fromHex(body.tx_hex);
    else throw new Error("missing");
  } catch { throw new ApiError(400, "bad_transaction", "Send {\"tx_hex\": \"…\"} or {\"psbt_base64\": \"…\"}."); }
  let unsigned = false;
  const txid = raw.getId();
  const vin = await Promise.all(raw.ins.map(async (inp, i) => {
    const prevTxid = Buffer.from(inp.hash).reverse().toString("hex"), outpoint = `${prevTxid}:${inp.index}`;
    let witness = (inp.witness ?? []).map((w) => Buffer.from(w).toString("hex"));
    const pin = psbt?.data.inputs[i];
    if (pin?.finalScriptWitness) {
      witness = decodeWitness(Buffer.from(pin.finalScriptWitness));
    } else if (!witness.length && pin?.tapLeafScript?.length) {
      const l = pin.tapLeafScript[0]!;
      witness = ["00".repeat(64), Buffer.from(l.script).toString("hex"), Buffer.from(l.controlBlock).toString("hex")];
      unsigned = true;
    } else if (!witness.length) unsigned = true;
    let prevout: TxOut | null = null;
    if (pin?.witnessUtxo) {
      const s = Buffer.from(pin.witnessUtxo.script);
      prevout = { value: Number(pin.witnessUtxo.value), scriptpubkey: s.toString("hex"), scriptpubkey_type: typeOf(s), ...withAddr(s, network) };
    } else {
      const coin = one<{ owner_address: string }>(db, "SELECT owner_address FROM seals WHERE outpoint = ?", outpoint);
      if (coin) { const s = Buffer.from(bitcoin.address.toOutputScript(coin.owner_address, network)); prevout = { value: 330, scriptpubkey: s.toString("hex"), scriptpubkey_type: typeOf(s), scriptpubkey_address: coin.owner_address }; }
      else if (rpc) {
        const u = await rpc.call<{ value: number; scriptPubKey: { hex: string; address?: string } } | null>("gettxout", [prevTxid, inp.index, true]).catch(() => null);
        if (u) { const s = Buffer.from(u.scriptPubKey.hex, "hex"); prevout = { value: Math.round(u.value * 1e8), scriptpubkey: u.scriptPubKey.hex, scriptpubkey_type: typeOf(s), ...withAddr(s, network) }; }
      }
    }
    return { txid: prevTxid, vout: inp.index, witness, prevout, sequence: inp.sequence };
  }));
  const vout = raw.outs.map((o) => { const s = Buffer.from(o.script); return { value: Number(o.value), scriptpubkey: s.toString("hex"), scriptpubkey_type: typeOf(s), ...withAddr(s, network) }; });
  return { tx: { txid, vin, vout }, unsigned };
}
const typeOf = (s: Buffer) => (s[0] === 0x6a ? "op_return" : s.length === 34 && s[0] === 0x51 && s[1] === 0x20 ? "v1_p2tr" : s.length === 22 && s[0] === 0 ? "v0_p2wpkh" : "other");
const withAddr = (s: Buffer, n: bitcoin.Network) => { const a = addressOf(s, n); return a ? { scriptpubkey_address: a } : {}; };
function decodeWitness(buf: Buffer): string[] {
  let i = 0; const rd = () => { const b = buf[i++]!; if (b < 0xfd) return b; if (b === 0xfd) { const v = buf.readUInt16LE(i); i += 2; return v; } const v = buf.readUInt32LE(i); i += 4; return v; };
  const n = rd(), out: string[] = [];
  for (let k = 0; k < n; k++) { const len = rd(); out.push(buf.subarray(i, i + len).toString("hex")); i += len; }
  return out;
}

/** The verdict a wallet shows before signing: what moves, and every way the transaction could lose tokens. */
export function verdict(db: Db, tx: Tx, eff: Effects, unsigned: boolean) {
  const warnings: { code: string; message: string; input?: number }[] = [];
  const spentByRule = new Set(eff.spent.map((s) => s.outpoint));
  tx.vin.forEach((v, i) => {
    const op = `${v.txid}:${v.vout}`;
    const coin = one<{ tick: string; amount_atoms: string; status: string }>(db, "SELECT tick, amount_atoms, status FROM seals WHERE outpoint = ?", op);
    if (coin && coin.status === "active" && !spentByRule.has(op))
      warnings.push({ code: "coin_lost", input: i, message: `Input ${i} spends a coin holding ${coin.amount_atoms} atoms of ${coin.tick}, but no rule moves it: those tokens would be lost.` });
  });
  const markers = markersOf(tx);
  if (markers.length && !eff.events.length && !eff.created.length) warnings.push({ code: "nothing_moved", message: "The transaction carries a CRC-20 marker but no rule accepts it: nothing would move." });
  if (!markers.length && eff.spent.length === 0 && warnings.length === 0) warnings.push({ code: "no_marker", message: "No CRC-20 marker: this is a plain Bitcoin transaction." });
  if (unsigned) warnings.push({ code: "unsigned", message: "Not signed yet: covenant inputs were checked with the leaf they will reveal (from the PSBT); signatures are not checked." });
  const rule = eff.events.some((e) => e.op === "mint") ? (eff.events.some((e) => e.op === "transfer") ? "launch_purchase" : "mint")
    : eff.events.some((e) => e.op === "merge") ? "merge" : eff.spent.length > 1 ? "batch" : eff.events.length ? "transfer" : "none";
  return { txid: tx.txid, rule, valid: !warnings.some((w) => w.code === "coin_lost" || w.code === "nothing_moved"), spent: eff.spent, created: eff.created, events: eff.events, warnings };
}
