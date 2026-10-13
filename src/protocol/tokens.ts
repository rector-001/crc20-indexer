// Shared facts about tokens that several rules read: a token's contract, proven covenant owners, the chain-derived
// BONS price, proof-of-burn, and a bonding token's raise status. Ported from crc20-stack src/indexer.mjs and
// src/launchpad.mjs (contract, price, proof-of-burn and status sections).
import * as bitcoin from "bitcoinjs-lib";
import { all, one, run, setCovenantOwner, getCovenantOwner } from "../store/ledger.js";
import { BONS_CMR, LAUNCH_SUPPLY, covenantOfWallet, covenantOutputKey, deriveCovenant, ownerKeyFromAddress } from "./covenant.js";
import { ONE, curveParams, usdMicrosPerBtc } from "./curve.js";
import { TICK, type Ctx } from "./context.js";
import type { Tx } from "./types.js";

export interface DeployRow { tick: string; type: string | null; max: string; lim: string; rate_json: string; deploy_txid: string; height: number; creator: string | null;
  target_usd: number | null; pob_txid: string | null; cmr: string | null; target_sats: string | null }

export const deployOf = (c: Ctx, tick: string): DeployRow | undefined => one<DeployRow>(c.db, "SELECT * FROM deploy WHERE tick=?", tick);
export const isDeployed = (c: Ctx, tick: string): boolean => !!one(c.db, "SELECT 1 FROM deploy WHERE tick=?", tick);

/** BONS -> its CMR; a bonding token -> its own contract; anything else -> null (it has none). */
export function tickCmr(c: Ctx, tick: string): string | null | undefined {
  if (tick === TICK) return undefined;                 // undefined = BONS's contract (the reference's convention)
  return deployOf(c, tick)?.cmr ?? null;
}
export const cmrHex = (cmr: string | null | undefined): string => cmr ?? BONS_CMR;

/* ── proven owners (shown by the API; never used to decide a balance) ─────────────────────────────────────────────── */

/** Link a covenant to the wallet that controls it — only when proven (the wallet's key rebuilds this exact covenant). */
export function linkCovenantOwner(c: Ctx, covenant: string, ownerXonly: string, source: string, cmr?: string) {
  if (!covenant || !ownerXonly) return;
  try {
    if (deriveCovenant(ownerXonly, cmrHex(cmr), c.btc).address !== covenant) return;
    const wallet = bitcoin.payments.p2tr({ pubkey: Buffer.from(ownerXonly, "hex"), network: c.btc }).address;
    if (wallet) setCovenantOwner(c.db, covenant, wallet, ownerXonly, source);
  } catch { /* not a valid key: no link */ }
}
/** A spend revealed the owner key; link it only when the owner's own wallet also paid into this transaction. */
export function linkRevealedOwner(c: Ctx, t: Tx, covenant: string, ownerXonly: string | null, cmr?: string) {
  if (!covenant || !ownerXonly) return;
  try {
    const taprootWallet = bitcoin.payments.p2tr({ pubkey: Buffer.from(ownerXonly, "hex"), network: c.btc }).address;
    for (const vin of t.vin) {
      const a = vin.prevout?.scriptpubkey_address, spk = vin.prevout?.scriptpubkey ?? "";
      if (a && a === taprootWallet) return linkCovenantOwner(c, covenant, ownerXonly, "reveal", cmr);
      const pub = vin.witness?.[1];
      if (a && spk.startsWith("0014") && typeof pub === "string" && pub.length === 66 && pub.slice(2) === ownerXonly) {
        if (deriveCovenant(ownerXonly, cmrHex(cmr), c.btc).address !== covenant) return;
        setCovenantOwner(c.db, covenant, a, ownerXonly, "reveal-segwit");
        return;
      }
    }
  } catch { /* no link */ }
}
/** A wallet that funded the transaction proves which receiving covenant is theirs. */
export function linkFunders(c: Ctx, t: Tx, covenants: (string | null | undefined)[], cmr?: string) {
  for (const cov of covenants) {
    if (!cov || getCovenantOwner(c.db, cov)) continue;
    for (const v of t.vin) {
      const a = v.prevout?.scriptpubkey_address;
      if (!a || !v.prevout?.scriptpubkey?.startsWith("5120")) continue;
      try { linkCovenantOwner(c, cov, ownerKeyFromAddress(a, c.btc), "input", cmr); } catch { /* not taproot */ }
      if (getCovenantOwner(c.db, cov)) break;
    }
  }
}

/* ── KEY BOOK: proven owners without the website ───────────────────────────────────────────────────────────────────────
 * A covenant is a one-way hash of (owner key, token contract): no one can turn a covenant back into a wallet, but anyone
 * can check a candidate. So every wallet key that appears in a CRC-20 transaction — a Taproot input or output key (the
 * wallet is that Taproot address) or a full public key in a witness (the wallet is its P2WPKH address) — goes into the
 * key book, with its covenant for EVERY token derived once. A coin whose covenant is in the book has a proven owner, even
 * for a token that wallet never touched before (it minted BONS, later received BCAT: both are named). A bare 32-byte
 * witness item is never assumed to be a wallet. None of this is consensus: it only names owners. */
const tokenContracts = (c: Ctx): [string, string][] =>
  [[TICK, BONS_CMR], ...all<{ tick: string; cmr: string }>(c.db, "SELECT tick, cmr FROM deploy WHERE cmr IS NOT NULL").map((r) => [r.tick, r.cmr] as [string, string])];

/** a covenant's address from its owner key — deriveCovenant's address, by the fast path */
const covAddress = (c: Ctx, owner: Buffer, cmr: Buffer | string) =>
  bitcoin.address.toBech32(Buffer.from(covenantOutputKey(owner, typeof cmr === "string" ? Buffer.from(cmr, "hex") : cmr), "hex"), 1, c.btc.bech32);
function nameIfHeld(c: Ctx, covenant: string, xonly: string, wallet: string) {
  if (getCovenantOwner(c.db, covenant)) return;
  if (one(c.db, "SELECT 1 FROM seals WHERE owner_address = ? LIMIT 1", covenant)) setCovenantOwner(c.db, covenant, wallet, xonly, "key-book");
}
function addKey(c: Ctx, xonly: string, wallet: string, height: number) {
  if (one(c.db, "SELECT 1 FROM key_book WHERE xonly = ?", xonly)) return;
  run(c.db, "INSERT INTO key_book(xonly, wallet, height) VALUES(?,?,?)", xonly, wallet, height);
  const kb = Buffer.from(xonly, "hex");
  for (const [tick, cmr] of tokenContracts(c)) {
    const cov = covAddress(c, kb, cmr);
    run(c.db, "INSERT OR IGNORE INTO cov_book(covenant, xonly, tick) VALUES(?,?,?)", cov, xonly, tick);
    nameIfHeld(c, cov, xonly, wallet);
  }
}
/** A new token: every key already in the book gets its covenant for it too. */
export function bookToken(c: Ctx, tick: string, cmr: string) {
  for (const k of all<{ xonly: string; wallet: string }>(c.db, "SELECT xonly, wallet FROM key_book")) {
    const cov = covAddress(c, Buffer.from(k.xonly, "hex"), Buffer.from(cmr, "hex"));
    run(c.db, "INSERT OR IGNORE INTO cov_book(covenant, xonly, tick) VALUES(?,?,?)", cov, k.xonly, tick);
  }
}
/** After a CRC-20 transaction: book its wallet keys, then name the owners of the coins it created. */
export function linkTxKeys(c: Ctx, t: Tx, height: number) {
  const taproot = (spk?: string, addr?: string) => { if (spk && addr && spk.length === 68 && spk.startsWith("5120")) addKey(c, spk.slice(4), addr, height); };
  for (const v of t.vin) taproot(v.prevout?.scriptpubkey, v.prevout?.scriptpubkey_address);
  for (const o of t.vout) taproot(o.scriptpubkey, o.scriptpubkey_address);
  for (const v of t.vin) for (const w of v.witness ?? []) {
    if (w.length === 66 && (w.startsWith("02") || w.startsWith("03"))) {
      try { const a = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(w, "hex"), network: c.btc }).address; if (a) addKey(c, w.slice(2), a, height); } catch { /* not a key */ }
    }
  }
  for (const { owner_address } of all<{ owner_address: string }>(c.db,
    "SELECT DISTINCT s.owner_address FROM seals s LEFT JOIN covenant_owners o ON o.covenant_address = s.owner_address WHERE s.txid = ? AND o.covenant_address IS NULL", t.txid)) {
    const b = one<{ xonly: string }>(c.db, "SELECT xonly FROM cov_book WHERE covenant = ?", owner_address);
    const w = b && one<{ wallet: string }>(c.db, "SELECT wallet FROM key_book WHERE xonly = ?", b.xonly);
    if (b && w) setCovenantOwner(c.db, owner_address, w.wallet, b.xonly, "key-book");
  }
}

/* ── OWNER KEYS ANYWHERE ON CHAIN: the covenants no CRC-20 transaction has named yet ──────────────────────────────────
 * A coin sent to a wallet that never touched CRC-20 has an owner the rules never see. But that wallet's key is its
 * Taproot output key, and it shows up the moment the wallet receives any bitcoin. So, after each block: every Taproot
 * output key in the block (all transactions, not only CRC-20 ones) is checked against the covenants that hold coins and
 * have no owner yet. Forward only — a key counts in the block its covenant first holds coins or any later block — so no
 * history of keys is kept, and every node that reads the same blocks names the same owners. A match is a proof (the
 * covenant is a hash of that key), and the key then enters the key book, which names its covenants of every other
 * token. Cost: one fixed-base multiplication per (new key, token with unnamed holders). Not consensus. */
interface Watch { dirty: boolean; byTick: Map<string, { cmr: Buffer; outKeys: Map<string, string> }>; tried: Map<string, string> }
const watches = new WeakMap<Ctx, Watch>();
/** counters for `--link-keys` cost (logged by the updater) */
export const linkStats = { blocks: 0, keys: 0, derived: 0, cached: 0, ticks: 0, ms: 0 };
const TRIED_MAX = 2_000_000;           // (key, token) pairs remembered: ~2M × ~150 bytes
function watchOf(c: Ctx): Watch {
  let w = watches.get(c);
  if (!w) { w = { dirty: true, byTick: new Map(), tried: new Map() }; watches.set(c, w); }
  if (w.dirty) {
    const sinks = new Set(c.sinks), contracts = new Map(tokenContracts(c));
    w.byTick.clear();
    for (const r of all<{ owner_address: string; tick: string }>(c.db,
      "SELECT DISTINCT s.owner_address, s.tick FROM seals s LEFT JOIN covenant_owners o ON o.covenant_address = s.owner_address WHERE s.status = 'active' AND o.covenant_address IS NULL")) {
      if (sinks.has(r.owner_address) || !contracts.has(r.tick)) continue;
      let out: string;
      try { out = Buffer.from(bitcoin.address.fromBech32(r.owner_address).data).toString("hex"); } catch { continue; }
      const t = w.byTick.get(r.tick) ?? { cmr: Buffer.from(contracts.get(r.tick)!, "hex"), outKeys: new Map() };
      t.outKeys.set(out, r.owner_address); w.byTick.set(r.tick, t);
    }
    w.dirty = false;
  }
  return w;
}
/** The burn chain is public: each sink is owned by the one before it (the burn covenant by the burn address). */
function nameSinks(c: Ctx) {
  for (let i = 1; i < c.sinks.length; i++) {
    if (getCovenantOwner(c.db, c.sinks[i]!) || !one(c.db, "SELECT 1 FROM seals WHERE owner_address = ? LIMIT 1", c.sinks[i]!)) continue;
    const parent = c.sinks[i - 1]!;
    setCovenantOwner(c.db, c.sinks[i]!, parent, Buffer.from(bitcoin.address.fromBech32(parent).data).toString("hex"), "burn-sink");
  }
}
export function linkBlockKeys(c: Ctx, taprootKeys: string[], height: number, blockHadMarkers: boolean) {
  const w = watches.get(c);
  if (blockHadMarkers || !w) { nameSinks(c); if (w) w.dirty = true; }
  const watch = watchOf(c);
  linkStats.blocks++;
  if (!watch.byTick.size) return;
  const t0 = performance.now();
  linkStats.keys += taprootKeys.length; linkStats.ticks += watch.byTick.size;
  let named = false;
  for (const key of taprootKeys) {
    const kb = Buffer.from(key, "hex");
    for (const [tick, t] of watch.byTick) {
      const id = key + tick;
      let out = watch.tried.get(id);
      if (out === undefined) {
        out = covenantOutputKey(kb, t.cmr); linkStats.derived++;
        if (watch.tried.size >= TRIED_MAX) watch.tried.clear();
        watch.tried.set(id, out);
      } else linkStats.cached++;
      const cov = t.outKeys.get(out);
      if (!cov || getCovenantOwner(c.db, cov)) continue;
      const wallet = bitcoin.address.toBech32(kb, 1, c.btc.bech32);
      setCovenantOwner(c.db, cov, wallet, key, "chain-key");
      addKey(c, key, wallet, height);            // its covenants of every other token, named as they hold coins
      named = true;
    }
  }
  if (named) watch.dirty = true;
  linkStats.ms += performance.now() - t0;
}
/** After a reorg the watch list is rebuilt from the ledger. */
export function resetKeyWatch(c: Ctx) { const w = watches.get(c); if (w) w.dirty = true; }

/* ── BONS price from sales read off the chain (micro-sats per whole BONS) ─────────────────────────────────────────── */

export function recordBonsFill(c: Ctx, f: { txid: string; height: number; sats: number; atoms: bigint }) {
  if (!(f.sats > 0) || !(f.atoms > 0n)) return;
  run(c.db, "INSERT OR IGNORE INTO bons_fills(txid,height,sats,atoms) VALUES(?,?,?,?)", f.txid, f.height, f.sats, String(f.atoms));
}
function vwMedian(fills: { sats: number; atoms: string }[]): bigint {
  const rows = fills.map((f) => ({ p: (BigInt(f.sats) * ONE * 1_000_000n) / BigInt(f.atoms), w: BigInt(f.atoms) }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const total = rows.reduce((s, r) => s + r.w, 0n);
  let acc = 0n;
  for (const r of rows) { acc += r.w; if (acc * 2n >= total) return r.p; }
  return rows[rows.length - 1]!.p;
}
export function bonsPriceAt(c: Ctx, height: number, btcUsd: string): bigint {
  const win = (blocks: number) => all<{ sats: number; atoms: string }>(c.db, "SELECT sats, atoms FROM bons_fills WHERE height > ? AND height <= ?", height - blocks, height);
  const two = win(12);
  if (two.length >= 3) return vwMedian(two);
  const five = win(30);
  if (five.length >= 3) return vwMedian(five);
  const last = all<{ sats: number; atoms: string }>(c.db, "SELECT sats, atoms FROM bons_fills WHERE height <= ? ORDER BY height DESC, txid DESC LIMIT 20", height);
  if (last.length) return vwMedian(last);
  const { p1 } = curveParams(c.curve);                 // no sale ever: the BONS curve's final price
  const usdPerBtc = usdMicrosPerBtc(btcUsd);
  return usdPerBtc > 0n ? (p1 * ONE * 1_000_000n) / usdPerBtc : 0n;
}
export function bonsUsdMicros(c: Ctx, height: number, btcUsd: string, atoms: bigint): bigint {
  const microsats = bonsPriceAt(c, height, btcUsd);
  const sats = (atoms * microsats) / (ONE * 1_000_000n);
  return (sats * usdMicrosPerBtc(btcUsd)) / ONE;
}

/* ── proof-of-burn: a $20 BONS burn from the creator's BONS covenant, each usable once ────────────────────────────── */

const POB_USD = 20n, POB_PRICE_WINDOW = 12;

function checkProofOfBurn(c: Ctx, pobTxid: string, creator: string, btcUsdAt: (h: number) => string): { ok: boolean; atoms?: bigint } {
  if (one(c.db, "SELECT 1 FROM pob_used WHERE burn_txid=?", pobTxid)) return { ok: false };
  const creatorCov = covenantOfWallet(creator, BONS_CMR, c.btc);
  if (!creatorCov) return { ok: false };
  const sinks = new Set(c.sinks);
  const rows = all<{ height: number; op: string; from_addr: string; to_addr: string; atoms: string }>(c.db, "SELECT height, op, from_addr, to_addr, atoms FROM deltas WHERE txid=?", pobTxid);
  if (rows.some((r) => r.op.startsWith("mint:"))) return { ok: false };               // a purchase, not a burn
  const burns = rows.filter((r) => (r.op === `transfer:${TICK}` && sinks.has(r.to_addr)) || r.op === `burn:${TICK}`);
  if (!burns.length || burns.some((r) => r.from_addr !== creatorCov)) return { ok: false };
  const atoms = burns.reduce((s, r) => s + BigInt(r.atoms), 0n);
  const h = burns[0]!.height;
  let usd = 0n;
  for (let hh = h - POB_PRICE_WINDOW; hh <= h; hh++) {
    const v = bonsUsdMicros(c, hh, btcUsdAt(hh), atoms);
    if (v > usd) usd = v;
  }
  return usd >= POB_USD * 1_000_000n ? { ok: true, atoms } : { ok: false };
}
/** The creator's oldest unused valid proof-of-burn at or below `height`. */
export function oldestUsableBurn(c: Ctx, creator: string, height: number, btcUsdAt: (h: number) => string): { txid: string } | null {
  const cov = covenantOfWallet(creator, BONS_CMR, c.btc);
  if (!cov) return null;
  const rows = all<{ txid: string; height: number }>(c.db,
    `SELECT DISTINCT d.txid, d.height FROM deltas d
      WHERE d.from_addr=? AND d.height<=? AND (d.op='burn:${TICK}' OR (d.op='transfer:${TICK}' AND d.to_addr IN (${c.sinks.map(() => "?").join(",")})))
        AND d.txid NOT IN (SELECT burn_txid FROM pob_used)
      ORDER BY d.height ASC, d.txid ASC`, cov, height, ...c.sinks);
  for (const r of rows) if (checkProofOfBurn(c, r.txid, creator, btcUsdAt).ok) return { txid: r.txid };
  return null;
}

/* ── a bonding token's raise ──────────────────────────────────────────────────────────────────────────────────────── */

export const LAUNCH_CLOSE_BLOCKS = 576;
export function launchStatus(dep: DeployRow, mintedAtoms: bigint, height: number): "minting" | "graduated" | "closed" {
  if (mintedAtoms >= LAUNCH_SUPPLY * ONE) return "graduated";
  if (height >= dep.height + LAUNCH_CLOSE_BLOCKS) return "closed";
  return "minting";
}
