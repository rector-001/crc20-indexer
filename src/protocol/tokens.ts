// Shared facts about tokens that several rules read: a token's contract, proven covenant owners, the chain-derived
// BONS price, proof-of-burn, and a bonding token's raise status. Ported from crc20-stack src/indexer.mjs and
// src/launchpad.mjs (contract, price, proof-of-burn and status sections).
import * as bitcoin from "bitcoinjs-lib";
import { all, one, run, setCovenantOwner, getCovenantOwner } from "../store/ledger.js";
import { BONS_CMR, LAUNCH_SUPPLY, covenantOfWallet, deriveCovenant, ownerKeyFromAddress } from "./covenant.js";
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

function nameIfHeld(c: Ctx, covenant: string, xonly: string, wallet: string) {
  if (getCovenantOwner(c.db, covenant)) return;
  if (one(c.db, "SELECT 1 FROM seals WHERE owner_address = ? LIMIT 1", covenant)) setCovenantOwner(c.db, covenant, wallet, xonly, "key-book");
}
function addKey(c: Ctx, xonly: string, wallet: string, height: number) {
  if (one(c.db, "SELECT 1 FROM key_book WHERE xonly = ?", xonly)) return;
  run(c.db, "INSERT INTO key_book(xonly, wallet, height) VALUES(?,?,?)", xonly, wallet, height);
  for (const [tick, cmr] of tokenContracts(c)) {
    let cov: string;
    try { cov = deriveCovenant(xonly, cmr, c.btc).address; } catch { return; }       // not a valid key
    run(c.db, "INSERT OR IGNORE INTO cov_book(covenant, xonly, tick) VALUES(?,?,?)", cov, xonly, tick);
    nameIfHeld(c, cov, xonly, wallet);
  }
}
/** A new token: every key already in the book gets its covenant for it too. */
export function bookToken(c: Ctx, tick: string, cmr: string) {
  for (const k of all<{ xonly: string; wallet: string }>(c.db, "SELECT xonly, wallet FROM key_book")) {
    try {
      const cov = deriveCovenant(k.xonly, cmr, c.btc).address;
      run(c.db, "INSERT OR IGNORE INTO cov_book(covenant, xonly, tick) VALUES(?,?,?)", cov, k.xonly, tick);
    } catch { /* not a valid key */ }
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
