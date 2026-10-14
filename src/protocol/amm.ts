// CURVE POOLS (TOKEN/BONS, x·y = k, from the amm activation; the 2% BONS fee from the ammFee activation). Ported from
// crc20-stack src/indexer.mjs (ammShape, applyAmm, ammWatchSlots, ammPayMatured) and src/ammfee.mjs.
//   amm-add    {"amt":["tok","bons"],"lock":"L"}  out k+1 token change, k+2 BONS change; a locked add may reserve
//                                                  payback slots at k+3 (token) and k+4 (BONS)
//   amm-swap   {"side":"buy"|"sell","amt":"in","min":"minOut"}  k+1 output coin, k+2 input change, k+3..k+6 fee coins
//   amm-remove {"amt":"shares"}                    k+1 token, k+2 BONS
import { all, createSeal, delta, one, run, spendSeal, tx } from "../store/ledger.js";
import { BONS_CMR, covenantOfWallet } from "./covenant.js";
import { AMM_FEE_ROLES, AMM_LOCKS, AMM_MIN_SHARES, ammFeeSplit, ammSwapMath, isqrtN } from "./curve.js";
import type { Marker } from "./message.js";
import { TICK, type Ctx } from "./context.js";
import { isActive } from "./constants/index.js";
import { deployOf, tickCmr } from "./tokens.js";
import { sealOk, sealsIn, type SealIn } from "./transfer.js";
import type { Tx, TxOut } from "./types.js";

const AMM_OPS = new Set(["amm-add", "amm-swap", "amm-remove"]);
const INT = /^(0|[1-9][0-9]{0,40})$/;

interface Pool { tick: string; reserve_tok: string; reserve_bons: string; shares: string }
interface Position { txid: string; tick: string; owner: string; shares: string; lock_until: number; auto: number; slot_tok: string | null; slot_bons: string | null; slot_tok_addr: string | null; slot_bons_addr: string | null }
type Coin330 = TxOut & { scriptpubkey_address: string };
export type AmmShape = { invalid: true } | { mk: Marker; owner: string | null; keyPath: boolean; outAt: (k: number) => Coin330 | null; seals: SealIn[]; inTok: bigint; inBons: bigint };

export function ammShape(c: Ctx, t: Tx, height: number, markers: Marker[]): AmmShape | null {
  if (!isActive(c.net.activations.amm, height)) return null;
  if (markers.length !== 1 || !AMM_OPS.has(String(markers[0]!.m.op))) return null;
  const mk = markers[0]!;
  if (mk.tick === TICK || tickCmr(c, mk.tick) === null) return { invalid: true };
  const owner = t.vin[0]?.prevout?.scriptpubkey_address ?? null;
  const keyPath = (t.vin[0]?.witness ?? []).length === 1;
  const outAt = (k: number): Coin330 | null => { const o = t.vout[k]; return o && o.value === 330 && o.scriptpubkey_address ? (o as Coin330) : null; };
  const seals = sealsIn(c, t);
  for (const x of seals) if (x.seal.txid === t.txid || !sealOk(c, t, x.seal, x.vin)) return { invalid: true };
  if (seals.some((x) => x.seal.tick !== mk.tick && x.seal.tick !== TICK)) return { invalid: true };
  const sum = (tick: string) => seals.filter((x) => x.seal.tick === tick).reduce((a, x) => a + BigInt(x.seal.amount_atoms), 0n);
  return { mk, owner, keyPath, outAt, seals, inTok: sum(mk.tick), inBons: sum(TICK) };
}

const poolOf = (c: Ctx, tick: string) => one<Pool>(c.db, "SELECT * FROM amm_pools WHERE tick=?", tick);
function coin(c: Ctx, t: Tx, height: number, k: number, tick: string, atoms: bigint, out: Coin330) {
  if (atoms <= 0n) return;
  createSeal(c.db, { outpoint: `${t.txid}:${k}`, tick, txid: t.txid, vout: k, height, owner_address: out.scriptpubkey_address, amount_atoms: atoms });
}
function logPool(c: Ctx, height: number, tick: string) {
  const p = poolOf(c, tick);
  if (p) run(c.db, "INSERT INTO amm_pool_log(height,tick,reserve_tok,reserve_bons,shares) VALUES(?,?,?,?,?)", height, tick, p.reserve_tok, p.reserve_bons, p.shares);
}
const logShare = (c: Ctx, height: number, pos: string, d: bigint, kind: string) =>
  run(c.db, "INSERT INTO amm_share_log(height,pos_txid,delta,kind) VALUES(?,?,?,?)", height, pos, String(d), kind);

/** The four BONS covenants the fee coins must pay (creator falls back to protocol); null when one is not configured. */
function feeRecipients(c: Ctx, tick: string): Record<(typeof AMM_FEE_ROLES)[number], string> | null {
  const cov = (a: string | null | undefined) => covenantOfWallet(a, BONS_CMR, c.btc);
  const protocol = cov(c.net.addresses.protocolFee), holders = cov(c.net.addresses.holders), partner = cov(c.net.addresses.partner);
  if (!protocol || !holders || !partner) return null;
  const creator = cov(deployOf(c, tick)?.creator) || protocol;
  return { creator, protocol, holders, partner };
}

/** A transaction spending a payback slot cancels that position's automatic payback (run for every transaction). */
export function ammWatchSlots(c: Ctx, t: Tx, height: number) {
  if (!isActive(c.net.activations.amm, height)) return;
  for (const vin of t.vin) {
    const op = `${vin.txid}:${vin.vout}`;
    const p = one<{ txid: string }>(c.db, "SELECT txid FROM amm_positions WHERE auto=1 AND paid_height IS NULL AND (slot_tok=? OR slot_bons=?)", op, op);
    if (p) { run(c.db, "UPDATE amm_positions SET auto=0 WHERE txid=?", p.txid); logShare(c, height, p.txid, 0n, "forfeit"); }
  }
}

/** End of block: locked positions that mature now are paid into their slots — no transaction needed. */
export function ammPayMatured(c: Ctx, height: number) {
  if (!isActive(c.net.activations.amm, height)) return;
  for (const pos of all<Position>(c.db, "SELECT * FROM amm_positions WHERE auto=1 AND paid_height IS NULL AND lock_until<=? ORDER BY height, txid", height)) {
    const pool = poolOf(c, pos.tick), sh = BigInt(pos.shares);
    if (!pool || sh <= 0n) { run(c.db, "UPDATE amm_positions SET paid_height=? WHERE txid=?", height, pos.txid); logShare(c, height, pos.txid, 0n, "payback"); continue; }
    const S = BigInt(pool.shares), Rt = BigInt(pool.reserve_tok), Rb = BigInt(pool.reserve_bons);
    const outTok = (sh * Rt) / S, outBons = (sh * Rb) / S;
    const [tTx, tV] = pos.slot_tok!.split(":") as [string, string], [bTx, bV] = pos.slot_bons!.split(":") as [string, string];
    if (outTok > 0n) createSeal(c.db, { outpoint: pos.slot_tok!, tick: pos.tick, txid: tTx, vout: Number(tV), height, owner_address: pos.slot_tok_addr!, amount_atoms: outTok });
    if (outBons > 0n) createSeal(c.db, { outpoint: pos.slot_bons!, tick: TICK, txid: bTx, vout: Number(bV), height, owner_address: pos.slot_bons_addr!, amount_atoms: outBons });
    run(c.db, "UPDATE amm_pools SET reserve_tok=?, reserve_bons=?, shares=? WHERE tick=?", (Rt - outTok).toString(), (Rb - outBons).toString(), (S - sh).toString(), pos.tick);
    run(c.db, "UPDATE amm_positions SET shares='0', paid_height=? WHERE txid=?", height, pos.txid);
    logShare(c, height, pos.txid, -sh, "payback"); logPool(c, height, pos.tick);
    delta(c.db, height, pos.txid, `amm-payback:${pos.tick}`, `pool:${pos.tick}`, pos.slot_tok_addr, outTok);
    delta(c.db, height, pos.txid, `amm-payback:${TICK}`, `pool:${pos.tick}`, pos.slot_bons_addr, outBons);
  }
}

export function applyAmm(c: Ctx, t: Tx, height: number, s: Exclude<AmmShape, { invalid: true }>) {
  const { mk, owner, keyPath, outAt, seals, inTok, inBons } = s, m = mk.m, T = mk.tick, k = mk.k;
  const pool = poolOf(c, T);
  if (m.op === "amm-add") {
    const amt = m.amt as unknown;
    if (!owner || !keyPath || !Array.isArray(amt) || amt.length !== 2 || !amt.every((x) => typeof x === "string" && INT.test(x))) return;
    const lock = m.lock === undefined ? 0 : Number(m.lock);
    if (!AMM_LOCKS.includes(lock)) return;
    const wantTok = BigInt(amt[0] as string), wantBons = BigInt(amt[1] as string);
    if (wantTok <= 0n || wantBons <= 0n || wantTok > inTok || wantBons > inBons) return;
    const cTok = outAt(k + 1), cBons = outAt(k + 2);
    if (!cTok || !cBons) return;
    let useTok: bigint, useBons: bigint, shares: bigint, next: { tok: bigint; bons: bigint; shares: bigint };
    if (!pool) {
      const root = isqrtN(wantTok * wantBons);
      if (root <= AMM_MIN_SHARES) return;
      useTok = wantTok; useBons = wantBons; shares = root - AMM_MIN_SHARES;
      next = { tok: useTok, bons: useBons, shares: root };
    } else {
      const Rt = BigInt(pool.reserve_tok), Rb = BigInt(pool.reserve_bons), S = BigInt(pool.shares);
      if (wantTok * Rb <= wantBons * Rt) { useTok = wantTok; shares = (wantTok * S) / Rt; useBons = (shares * Rb + S - 1n) / S; }
      else { useBons = wantBons; shares = (wantBons * S) / Rb; useTok = (shares * Rt + S - 1n) / S; }
      if (shares <= 0n || useTok > wantTok || useBons > wantBons) return;
      next = { tok: Rt + useTok, bons: Rb + useBons, shares: S + shares };
    }
    tx(c.db, () => {
      for (const x of seals) spendSeal(c.db, x.seal.outpoint, t.txid);
      coin(c, t, height, k + 1, T, inTok - useTok, cTok);
      coin(c, t, height, k + 2, TICK, inBons - useBons, cBons);
      if (pool) run(c.db, "UPDATE amm_pools SET reserve_tok=?, reserve_bons=?, shares=? WHERE tick=?", next.tok.toString(), next.bons.toString(), next.shares.toString(), T);
      else run(c.db, "INSERT INTO amm_pools(tick,reserve_tok,reserve_bons,shares,created_height,created_txid) VALUES(?,?,?,?,?,?)", T, next.tok.toString(), next.bons.toString(), next.shares.toString(), height, t.txid);
      const sTok = lock > 0 ? outAt(k + 3) : null, sBons = lock > 0 ? outAt(k + 4) : null, auto = sTok && sBons ? 1 : 0;
      run(c.db, `INSERT INTO amm_positions(txid,tick,owner,shares,lock_until,height,auto,slot_tok,slot_bons,slot_tok_addr,slot_bons_addr) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        t.txid, T, owner, shares.toString(), height + lock, height, auto,
        auto ? `${t.txid}:${k + 3}` : null, auto ? `${t.txid}:${k + 4}` : null, auto ? sTok!.scriptpubkey_address : null, auto ? sBons!.scriptpubkey_address : null);
      logPool(c, height, T);
      delta(c.db, height, t.txid, `amm-add:${T}`, owner, `pool:${T}`, useTok);
      delta(c.db, height, t.txid, `amm-add:${TICK}`, owner, `pool:${T}`, useBons);
    });
    return;
  }
  if (!pool) return;
  const Rt = BigInt(pool.reserve_tok), Rb = BigInt(pool.reserve_bons), S = BigInt(pool.shares);
  if (m.op === "amm-swap") {
    const min = (m.min ?? "0") as unknown;
    if (!["buy", "sell"].includes(String(m.side)) || typeof m.amt !== "string" || !INT.test(m.amt) || typeof min !== "string" || !INT.test(min)) return;
    const buy = m.side === "buy", inTick = buy ? TICK : T, outTick = buy ? T : TICK;
    const have = buy ? inBons : inTok, other = buy ? inTok : inBons;
    const amt = BigInt(m.amt), minOut = BigInt(min);
    if (other !== 0n || amt <= 0n || amt > have) return;
    const recv = outAt(k + 1), change = outAt(k + 2);
    if (!recv || !change) return;
    const Rin = buy ? Rb : Rt, Rout = buy ? Rt : Rb;
    const feeOn = isActive(c.net.activations.ammFee, height);
    const { out, outPool, inPool, proto } = ammSwapMath({ buy, amt, Rin, Rout, feeOn });
    let feeSlots: Coin330[] | null = null;
    if (feeOn) {
      const R = feeRecipients(c, T), slots = AMM_FEE_ROLES.map((_, i) => outAt(k + 3 + i));
      if (R && slots.every((o, i) => o && o.scriptpubkey_address === R[AMM_FEE_ROLES[i]!])) feeSlots = slots as Coin330[];
    }
    tx(c.db, () => {
      for (const x of seals) spendSeal(c.db, x.seal.outpoint, t.txid);
      if (out <= 0n || out < minOut || outPool >= Rout || (feeOn && !feeSlots)) {      // slippage / dust / no fee slots: all back
        coin(c, t, height, k + 2, inTick, have, change);
        delta(c.db, height, t.txid, `amm-refund:${inTick}`, owner, change.scriptpubkey_address, have);
        return;
      }
      coin(c, t, height, k + 1, outTick, out, recv);
      coin(c, t, height, k + 2, inTick, have - amt, change);
      const nRt = buy ? Rt - outPool : Rt + inPool, nRb = buy ? Rb + inPool : Rb - outPool;
      run(c.db, "UPDATE amm_pools SET reserve_tok=?, reserve_bons=? WHERE tick=?", nRt.toString(), nRb.toString(), T);
      logPool(c, height, T);
      delta(c.db, height, t.txid, `amm-swap:${inTick}`, owner, `pool:${T}`, inPool);
      delta(c.db, height, t.txid, `amm-swap:${outTick}`, `pool:${T}`, recv.scriptpubkey_address, out);
      if (feeSlots && proto > 0n) {
        const f = ammFeeSplit(proto);
        AMM_FEE_ROLES.forEach((role, i) => {
          coin(c, t, height, k + 3 + i, TICK, f[role], feeSlots![i]!);
          if (f[role] > 0n) delta(c.db, height, t.txid, `amm-fee:${role}`, buy ? owner : `pool:${T}`, feeSlots![i]!.scriptpubkey_address, f[role]);
        });
      }
    });
    return;
  }
  if (m.op === "amm-remove") {
    if (!owner || !keyPath || typeof m.amt !== "string" || !INT.test(m.amt) || seals.length) return;
    const want = BigInt(m.amt);
    const recvTok = outAt(k + 1), recvBons = outAt(k + 2);
    if (want <= 0n || !recvTok || !recvBons) return;
    const mine = all<{ txid: string; shares: string }>(c.db, "SELECT txid, shares FROM amm_positions WHERE tick=? AND owner=? AND lock_until<=? AND CAST(shares AS INTEGER)>0 ORDER BY height, txid", T, owner, height);
    if (mine.reduce((a, p) => a + BigInt(p.shares), 0n) < want) return;
    const outTok = (want * Rt) / S, outBons = (want * Rb) / S;
    if (outTok <= 0n && outBons <= 0n) return;
    tx(c.db, () => {
      let left = want;
      for (const p of mine) {
        if (left <= 0n) break;
        const take = BigInt(p.shares) < left ? BigInt(p.shares) : left;
        run(c.db, "UPDATE amm_positions SET shares=? WHERE txid=?", (BigInt(p.shares) - take).toString(), p.txid);
        logShare(c, height, p.txid, -take, "remove");
        left -= take;
      }
      coin(c, t, height, k + 1, T, outTok, recvTok);
      coin(c, t, height, k + 2, TICK, outBons, recvBons);
      run(c.db, "UPDATE amm_pools SET reserve_tok=?, reserve_bons=?, shares=? WHERE tick=?", (Rt - outTok).toString(), (Rb - outBons).toString(), (S - want).toString(), T);
      logPool(c, height, T);
      delta(c.db, height, t.txid, `amm-remove:${T}`, `pool:${T}`, recvTok.scriptpubkey_address, outTok);
      delta(c.db, height, t.txid, `amm-remove:${TICK}`, `pool:${T}`, recvBons.scriptpubkey_address, outBons);
    });
  }
}
