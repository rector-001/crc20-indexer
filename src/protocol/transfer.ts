// TRANSFERS. Ported from crc20-stack src/indexer.mjs: the single transfer (op "transfer"), batch (transferBatchShape,
// planTransferBatch), merge (mergeShape), and the coin check merge uses.
import { addBurnedAtoms, createSeal, delta, getCovenantOwner, getSeal, spendSeal, tx, type Seal } from "../store/ledger.js";
import { covenantOfWallet, covenantWitness, leafCmr, ownerFromLeaf, BONS_CMR } from "./covenant.js";
import { bigOrNull, type Marker } from "./message.js";
import { TICK, type Ctx } from "./context.js";
import { isActive } from "./constants/index.js";
import { linkFunders, linkRevealedOwner, recordBonsFill, tickCmr } from "./tokens.js";
import type { Tx, TxIn, TxOut } from "./types.js";

export interface SealIn { seal: Seal; vin: TxIn; index: number }

/** Every live coin this transaction spends, in input order. */
export function sealsIn(c: Ctx, t: Tx): SealIn[] {
  const out: SealIn[] = [];
  t.vin.forEach((vin, index) => {
    const seal = getSeal(c.db, `${vin.txid}:${vin.vout}`);
    if (seal && seal.status === "active") out.push({ seal, vin, index });
  });
  return out;
}

/** A 330-sat output with an address — the only kind a coin can be created at. */
const coinOut = (o: TxOut | undefined): o is TxOut & { scriptpubkey_address: string } => !!o && o.value === 330 && !!o.scriptpubkey_address;

/** May this coin move in this transaction? (merge's check) */
export function sealOk(c: Ctx, t: Tx, seal: Seal, vin: TxIn): { tokenCmr: string | undefined } | null {
  if (seal.txid === t.txid || seal.status !== "active") return null;
  const w = covenantWitness(vin.witness, c.btc);
  let tokenCmr: string | undefined;
  if (seal.tick !== TICK) {
    const cmr = tickCmr(c, seal.tick);
    if (!cmr || !w || leafCmr(w.leaf) !== cmr) return null;
    tokenCmr = cmr;
  }
  if (seal.kind === "allocation" && !w) return null;
  return { tokenCmr };
}

/** The same check as the single transfer and the batch apply (no "active" test: the caller already has a live coin). */
function transferCoinOk(c: Ctx, seal: Seal, vin: TxIn): { tokenCmr: string | undefined } | null {
  const w = covenantWitness(vin.witness, c.btc);
  let tokenCmr: string | undefined;
  if (seal.tick !== TICK) {
    const cmr = tickCmr(c, seal.tick);
    if (!cmr || !w || leafCmr(w.leaf) !== cmr) return null;
    tokenCmr = cmr;
  }
  if (seal.kind === "allocation" && !w) return null;
  return { tokenCmr };
}

function revealOwner(c: Ctx, t: Tx, seal: Seal, vin: TxIn, tokenCmr: string | undefined) {
  const w = covenantWitness(vin.witness, c.btc);
  if (w && !getCovenantOwner(c.db, seal.owner_address)) linkRevealedOwner(c, t, seal.owner_address, ownerFromLeaf(w.leaf), tokenCmr);
}

/** A BONS sale: the seller's SIGHASH_SINGLE|ANYONECANPAY (0x83) signature on the coin input, and the output at the
 *  same position paying the seller's wallet. Recorded for the chain-derived BONS price (proof-of-burn). */
function maybeRecordSale(c: Ctx, t: Tx, height: number, seal: Seal, vin: TxIn, payIndex: number, atoms: bigint, key: string) {
  const sig = String(vin.witness?.[0] ?? "");
  const isOffer = sig.length === 130 && sig.slice(-2).toLowerCase() === "83";
  const pay = t.vout[payIndex];
  if (seal.tick === TICK && isOffer && pay && pay.value > 546 && pay.scriptpubkey_address
      && covenantOfWallet(pay.scriptpubkey_address, BONS_CMR, c.btc) === seal.owner_address)
    recordBonsFill(c, { txid: key, height, sats: pay.value, atoms });
}

/* ── single transfer ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** The first live coin among the inputs moves: `amt` to the 330 output after the marker, the rest to the one after that.
 *  NOTE (reference behaviour, kept): the coin's own token moves, whatever the marker's tick says. */
export function applySingleTransfer(c: Ctx, t: Tx, height: number, mk: Marker) {
  const spent = sealsIn(c, t)[0];
  if (!spent) return;
  const { seal, vin } = spent;
  if (seal.txid === t.txid || seal.status === "voided") return;
  const ok = transferCoinOk(c, seal, vin);
  if (!ok) return;
  revealOwner(c, t, seal, vin, ok.tokenCmr);
  const amt = bigOrNull(mk.m.amt);
  const sealAtoms = BigInt(seal.amount_atoms);
  if (amt === null || amt <= 0n || amt > sealAtoms) return;
  const recv = t.vout[mk.k + 1];
  if (!coinOut(recv)) return;
  const change = sealAtoms - amt;
  const changeOut = change > 0n ? t.vout[mk.k + 2] : undefined;
  if (change > 0n && !coinOut(changeOut)) return;
  const toBurn = recv.scriptpubkey_address === c.directBurn, tick = seal.tick;
  tx(c.db, () => {
    spendSeal(c.db, seal.outpoint, t.txid);
    if (toBurn) addBurnedAtoms(c.db, amt, tick);
    else createSeal(c.db, { outpoint: `${t.txid}:${mk.k + 1}`, tick, txid: t.txid, vout: mk.k + 1, height, owner_address: recv.scriptpubkey_address, amount_atoms: amt });
    if (change > 0n) createSeal(c.db, { outpoint: `${t.txid}:${mk.k + 2}`, tick, txid: t.txid, vout: mk.k + 2, height, owner_address: changeOut!.scriptpubkey_address!, amount_atoms: change });
    delta(c.db, height, t.txid, toBurn ? `burn:${tick}` : `transfer:${tick}`, seal.owner_address, toBurn ? c.directBurn : recv.scriptpubkey_address, amt);
  });
  maybeRecordSale(c, t, height, seal, vin, 0, amt, t.txid);
  linkFunders(c, t, [toBurn ? null : recv.scriptpubkey_address, changeOut?.scriptpubkey_address], ok.tokenCmr);
}

/* ── batch: 2+ coins, one transfer marker each ─────────────────────────────────────────────────────────────────────── */

export interface BatchPlan { seal: Seal; vin: TxIn; index: number; k: number; amt: bigint; recv: TxOut & { scriptpubkey_address: string }; changeAtoms: bigint; changeOut?: TxOut; tokenCmr: string | undefined; toBurn: boolean }

/** 2+ transfer markers and 2+ coins spent: a batch; else null (the single transfer applies). */
export function batchShape(c: Ctx, t: Tx, markers: Marker[]): { markers: Marker[]; seals: SealIn[] } | null {
  if (markers.length < 2 || markers.some((x) => x.m.op !== "transfer")) return null;
  const seals = sealsIn(c, t);
  if (seals.length < 2) return null;
  return { markers, seals };
}

/** Plan a batch: marker j moves coin j. All or nothing — null when any pair fails. */
export function planBatch(c: Ctx, t: Tx, markers: Marker[], seals: SealIn[]): BatchPlan[] | null {
  if (markers.length !== seals.length) return null;
  const plans: BatchPlan[] = [];
  let prevEnd = -1;
  for (let j = 0; j < markers.length; j++) {
    const { m, k, tick } = markers[j]!;
    const { seal, vin, index } = seals[j]!;
    if (k <= prevEnd) return null;
    if (seal.txid === t.txid || seal.status === "voided") return null;
    if (tick !== seal.tick) return null;
    const ok = transferCoinOk(c, seal, vin);
    if (!ok) return null;
    const amt = bigOrNull(m.amt);
    const sealAtoms = BigInt(seal.amount_atoms);
    if (amt === null || amt <= 0n || amt > sealAtoms) return null;
    const recv = t.vout[k + 1];
    if (!coinOut(recv)) return null;
    const changeAtoms = sealAtoms - amt;
    const changeOut = changeAtoms > 0n ? t.vout[k + 2] : undefined;
    if (changeAtoms > 0n && !coinOut(changeOut)) return null;
    prevEnd = k + (changeAtoms > 0n ? 2 : 1);
    plans.push({ seal, vin, index, k, amt, recv, changeAtoms, changeOut, tokenCmr: ok.tokenCmr, toBurn: recv.scriptpubkey_address === c.directBurn });
  }
  return plans;
}

export function commitBatch(c: Ctx, t: Tx, height: number, plans: BatchPlan[]) {
  for (const p of plans) revealOwner(c, t, p.seal, p.vin, p.tokenCmr);
  tx(c.db, () => {
    for (const p of plans) {
      const tick = p.seal.tick;
      spendSeal(c.db, p.seal.outpoint, t.txid);
      if (p.amt > 0n) {
        if (p.toBurn) addBurnedAtoms(c.db, p.amt, tick);
        else createSeal(c.db, { outpoint: `${t.txid}:${p.k + 1}`, tick, txid: t.txid, vout: p.k + 1, height, owner_address: p.recv.scriptpubkey_address, amount_atoms: p.amt });
      }
      if (p.changeAtoms > 0n)
        createSeal(c.db, { outpoint: `${t.txid}:${p.k + 2}`, tick, txid: t.txid, vout: p.k + 2, height, owner_address: p.changeOut!.scriptpubkey_address!, amount_atoms: p.changeAtoms });
      if (p.amt > 0n) delta(c.db, height, t.txid, p.toBurn ? `burn:${tick}` : `transfer:${tick}`, p.seal.owner_address, p.toBurn ? c.directBurn : p.recv.scriptpubkey_address, p.amt);
    }
  });
  for (const p of plans) {
    maybeRecordSale(c, t, height, p.seal, p.vin, p.index, p.amt, `${t.txid}:${p.index}`);
    linkFunders(c, t, [p.toBurn ? null : p.recv.scriptpubkey_address, p.changeOut?.scriptpubkey_address], p.tokenCmr);
  }
}

/* ── merge: one transfer marker, 2+ coins of its token, amt = their exact total (from its activation) ─────────────── */

export function mergeShape(c: Ctx, t: Tx, height: number, markers: Marker[]): { mk: Marker; seals: SealIn[]; amt: bigint; recv: TxOut & { scriptpubkey_address: string } } | null {
  if (!isActive(c.net.activations.merge, height)) return null;
  if (markers.length !== 1 || markers[0]!.m.op !== "transfer") return null;
  const seals = sealsIn(c, t);
  if (seals.length < 2) return null;
  const mk = markers[0]!;
  if (seals.some((x) => x.seal.tick !== mk.tick)) return null;
  const amt = bigOrNull(mk.m.amt);
  if (amt === null) return null;
  const total = seals.reduce((a, x) => a + BigInt(x.seal.amount_atoms), 0n);
  if (amt !== total || amt <= 0n) return null;
  const recv = t.vout[mk.k + 1];
  if (!coinOut(recv)) return null;
  for (const x of seals) if (!sealOk(c, t, x.seal, x.vin)) return null;
  return { mk, seals, amt, recv };
}

export function applyMerge(c: Ctx, t: Tx, height: number, s: NonNullable<ReturnType<typeof mergeShape>>) {
  const tick = s.mk.tick, toBurn = s.recv.scriptpubkey_address === c.directBurn;
  for (const x of s.seals) revealOwner(c, t, x.seal, x.vin, tickCmr(c, tick) ?? undefined);
  tx(c.db, () => {
    for (const x of s.seals) spendSeal(c.db, x.seal.outpoint, t.txid);
    if (toBurn) addBurnedAtoms(c.db, s.amt, tick);
    else createSeal(c.db, { outpoint: `${t.txid}:${s.mk.k + 1}`, tick, txid: t.txid, vout: s.mk.k + 1, height, owner_address: s.recv.scriptpubkey_address, amount_atoms: s.amt });
    delta(c.db, height, t.txid, toBurn ? `burn:${tick}` : `merge:${tick}`, s.seals[0]!.seal.owner_address, toBurn ? c.directBurn : s.recv.scriptpubkey_address, s.amt);
  });
}

