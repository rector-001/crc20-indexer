// RESTING TOKEN/BONS OFFERS ("bound triples", from the poolSwap activation). Ported from crc20-stack src/indexer.mjs
// (poolSwapShape, planPoolSwap, commitPoolSwap, refundPoolSwap).
//
// A maker's offer is three inputs, each signed SIGHASH_SINGLE|ANYONECANPAY, bound to the output at its own position:
//   input j    the coin offered        -> output j    a transfer marker of the OTHER token (what the maker wants)
//   input j+1  a 330-sat coin          -> output j+1  330 to the maker's covenant for the wanted token
//   input j+2  a 330-sat coin          -> output j+2  330 back to the offered coin's own address (refund slot)
// VALID: everything moves at once. INVALID: nothing moves, and every offered coin goes back to its refund slot.
import { addBurnedAtoms, createSeal, delta, getCovenantOwner, spendSeal, tx } from "../store/ledger.js";
import { covenantWitness, deriveCovenant, ownerFromLeaf } from "./covenant.js";
import { bigOrNull, type Marker } from "./message.js";
import type { Ctx } from "./context.js";
import { isActive } from "./constants/index.js";
import { cmrHex, linkRevealedOwner, tickCmr } from "./tokens.js";
import { sealOk, sealsIn, type SealIn } from "./transfer.js";
import type { Tx, TxOut } from "./types.js";

interface Triple { j: number; offered: SealIn; want: Marker; refundK: number }
export interface PoolShape { markers: Marker[]; seals: SealIn[]; triples: Triple[] }

export function poolShape(c: Ctx, t: Tx, height: number, markers: Marker[]): PoolShape | null {
  if (!isActive(c.net.activations.poolSwap, height) || markers.length < 2) return null;
  const seals = sealsIn(c, t);
  const triples: Triple[] = [];
  for (const mk of markers) {
    const j = mk.k;
    const off = seals.find((x) => x.index === j);
    if (!off || mk.tick === off.seal.tick) continue;
    const w = off.vin.witness ?? [];
    if (w.length < 2) continue;
    const ownerHex = ownerFromLeaf(w[w.length - 2]!);
    const wantCmr = tickCmr(c, mk.tick);
    if (!ownerHex || wantCmr === null) continue;
    let wantCov: string;
    try { wantCov = deriveCovenant(ownerHex, cmrHex(wantCmr), c.btc).address; } catch { continue; }
    const recv = t.vout[j + 1], refund = t.vout[j + 2];
    if (!recv || recv.value !== 330 || recv.scriptpubkey_address !== wantCov) continue;
    if (!refund || refund.value !== 330 || refund.scriptpubkey_address !== off.seal.owner_address) continue;
    triples.push({ j, offered: off, want: mk, refundK: j + 2 });
  }
  return triples.length ? { markers, seals, triples } : null;
}

interface Move { seal: SealIn["seal"]; k: number; amt: bigint; recv: TxOut & { scriptpubkey_address: string }; toBurn: boolean }

function plan(c: Ctx, t: Tx, s: PoolShape): Move[] | null {
  if (s.markers.some((x) => x.m.op !== "transfer")) return null;
  const markerKs = new Set(s.markers.map((x) => x.k)), refundKs = new Set(s.triples.map((x) => x.refundK)), usedRecv = new Set<number>();
  const checked = new Map<string, ReturnType<typeof sealOk>>();
  const moves: Move[] = [];
  const ticks = new Set([...s.markers.map((x) => x.tick), ...s.seals.map((x) => x.seal.tick)]);
  for (const T of ticks) {
    const ms = s.markers.filter((x) => x.tick === T), ss = s.seals.filter((x) => x.seal.tick === T);
    if (!ms.length || !ss.length) return null;
    let pairs: [Marker, SealIn][];
    if (ms.length === ss.length) pairs = ms.map((mk, i) => [mk, ss[i]!]);
    else if (ss.length === 1) pairs = ms.map((mk) => [mk, ss[0]!]);
    else return null;
    const paid = new Map<string, bigint>();
    for (const [mk, sv] of pairs) {
      if (!checked.has(sv.seal.outpoint)) checked.set(sv.seal.outpoint, sealOk(c, t, sv.seal, sv.vin));
      if (!checked.get(sv.seal.outpoint)) return null;
      const amt = bigOrNull(mk.m.amt);
      if (amt === null || amt <= 0n) return null;
      const rk = mk.k + 1, recv = t.vout[rk];
      if (!recv || recv.value !== 330 || !recv.scriptpubkey_address) return null;
      if (markerKs.has(rk) || refundKs.has(rk) || usedRecv.has(rk)) return null;
      usedRecv.add(rk);
      paid.set(sv.seal.outpoint, (paid.get(sv.seal.outpoint) ?? 0n) + amt);
      moves.push({ seal: sv.seal, k: mk.k, amt, recv: recv as Move["recv"], toBurn: recv.scriptpubkey_address === c.directBurn });
    }
    for (const sv of ss) if (paid.get(sv.seal.outpoint) !== BigInt(sv.seal.amount_atoms)) return null;   // exact: no change
  }
  return moves;
}

export function applyPool(c: Ctx, t: Tx, height: number, s: PoolShape) {
  const moves = plan(c, t, s);
  if (moves) {
    for (const sv of s.seals) {
      const w = covenantWitness(sv.vin.witness, c.btc);
      if (w && !getCovenantOwner(c.db, sv.seal.owner_address)) linkRevealedOwner(c, t, sv.seal.owner_address, ownerFromLeaf(w.leaf), tickCmr(c, sv.seal.tick) ?? undefined);
    }
    tx(c.db, () => {
      for (const sv of s.seals) spendSeal(c.db, sv.seal.outpoint, t.txid);
      for (const mv of moves) {
        const tick = mv.seal.tick;
        if (mv.toBurn) addBurnedAtoms(c.db, mv.amt, tick);
        else createSeal(c.db, { outpoint: `${t.txid}:${mv.k + 1}`, tick, txid: t.txid, vout: mv.k + 1, height, owner_address: mv.recv.scriptpubkey_address, amount_atoms: mv.amt });
        delta(c.db, height, t.txid, mv.toBurn ? `burn:${tick}` : `swap:${tick}`, mv.seal.owner_address, mv.toBurn ? c.directBurn : mv.recv.scriptpubkey_address, mv.amt);
      }
    });
    return;
  }
  // invalid: every offered coin goes back to its own refund slot — a maker never loses a coin to a transaction that does not pay them
  tx(c.db, () => {
    for (const tr of s.triples) {
      const sl = tr.offered.seal;
      if (sl.txid === t.txid || sl.status !== "active") continue;
      spendSeal(c.db, sl.outpoint, t.txid);
      createSeal(c.db, { outpoint: `${t.txid}:${tr.refundK}`, tick: sl.tick, txid: t.txid, vout: tr.refundK, height, owner_address: sl.owner_address, amount_atoms: sl.amount_atoms });
      delta(c.db, height, t.txid, `refund:${sl.tick}`, sl.owner_address, sl.owner_address, sl.amount_atoms);
    }
  });
}
