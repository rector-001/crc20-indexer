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
