// MINT. Ported from crc20-stack src/indexer.mjs (op "mint", applyLaunchMint, launchPurchaseShape / applyLaunchPurchase).
// The 2% per-buyer cap applies only in its historical window (constants: launchWalletCap).
//
//   BONS            marker {"op":"mint","tick":"BONS"}: BTC paid to the treasury, priced on the BONS curve
//   bonding token   marker {"op":"mint","tick":T}: BTC paid in the 45/45/10 split (creator / flywheel / treasury) or,
//                   from the holding address's height, its whole amount to the holding address; exact-area curve
//   bonding token   paid in BONS: transfer(80%) + transfer(20%) + mint marker, see applyBonsPurchase
import { addMintedAtoms, addOpeningMintedAtoms, addRaiseSats, all, createSeal, delta, getMintedAtoms, getOpeningMintedAtoms, getPublicMintedAtoms, one, tx, type Seal } from "../store/ledger.js";
import { BONS_CMR, covenantOfWallet, deriveCovenant, ownerFromLeaf, ownerKeyFromAddress } from "./covenant.js";
import { bonsBudgetMicroSats, curveParams, quoteBonsMint, quoteLaunch } from "./curve.js";
import { TICK, type Ctx } from "./context.js";
import type { Marker } from "./message.js";
import { deployOf, launchStatus, linkCovenantOwner } from "./tokens.js";
import type { Tx } from "./types.js";

/* ── BONS ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export function applyBonsMint(c: Ctx, t: Tx, height: number, mk: Marker, btcUsd: string) {
  if (!deployOf(c, TICK)) return;
  const treasury = c.net.addresses.treasury, k = mk.k;
  // capital = every output (not the marker) above 330 sats paid to the treasury
  let capital = 0n;
  t.vout.forEach((o, i) => { if (i !== k && o.value > 330 && o.scriptpubkey_address === treasury) capital += BigInt(o.value); });
  // the coin: the first 330-sat P2TR output that is neither the marker nor a treasury output
  const sealVout = t.vout.findIndex((o, i) => i !== k && o.value === 330 && o.scriptpubkey_type === "v1_p2tr" && o.scriptpubkey_address !== treasury);
  if (sealVout < 0) return;
  const sealAddr = t.vout[sealVout]!.scriptpubkey_address!;
  const payer = t.vin[0]?.prevout?.scriptpubkey_address ?? null;
  const onOpening = !!c.net.addresses.curveOpeningPayer && payer === c.net.addresses.curveOpeningPayer
    && getOpeningMintedAtoms(c.db, TICK) < curveParams(c.curve).openingAtoms;
  const q = quoteBonsMint({ sats: capital, btcUsd, publicMinted: getPublicMintedAtoms(c.db, TICK), openingMinted: getOpeningMintedAtoms(c.db, TICK), onOpening, curve: c.curve });
  if (q.allocatedAtoms <= 0n) return;
  const slope = q.slope ?? "public";
  tx(c.db, () => {
    createSeal(c.db, { outpoint: `${t.txid}:${sealVout}`, tick: TICK, txid: t.txid, vout: sealVout, height, owner_address: sealAddr,
      amount_atoms: q.allocatedAtoms, kind: "allocation", bucket: slope });
    addMintedAtoms(c.db, q.allocatedAtoms, TICK);
    addRaiseSats(c.db, capital, TICK, height, t.txid);
    try { if (payer) linkCovenantOwner(c, sealAddr, ownerKeyFromAddress(payer, c.btc), "payer"); } catch { /* not taproot */ }
    if (slope === "opening") addOpeningMintedAtoms(c.db, q.allocatedAtoms, TICK);
    delta(c.db, height, t.txid, `mint:${TICK}`, null, sealAddr, q.allocatedAtoms);
  });
}


/** The historical 2% per-buyer cap (constants: launchWalletCap). Returns the atoms allowed, 0n = none. */
function walletCap(c: Ctx, tick: string, allocCov: string, atoms: bigint, height: number): bigint {
  const w = c.net.activations.launchWalletCap;
  if (!w || height < w.from || (w.until !== null && height >= w.until)) return atoms;
  const CAP = (1_000_000_000n * 100_000_000n * 200n) / 10_000n;
  const had = all<{ atoms: string }>(c.db, "SELECT atoms FROM deltas WHERE op=? AND to_addr=?", `mint:${tick}`, allocCov).reduce((a, r) => a + BigInt(r.atoms), 0n);
  const room = CAP - had;
  return room <= 0n ? 0n : atoms > room ? room : atoms;
}

/* ── bonding token, paid in BTC ───────────────────────────────────────────────────────────────────────────────────── */

const SPLIT_BTC = { creator: 4500n, flywheel: 4500n, treasury: 1000n };

/** BTC credited to a purchase: everything paid to the holding address (from its height), else the largest amount the
 *  three payments support at the exact 45/45/10 split. */
function btcPurchaseCapital(c: Ctx, t: Tx, k: number, creator: string | null, height: number): bigint {
  const esc = c.net.addresses.launchEscrow;
  if (esc && height >= esc.from) {
    let paid = 0n;
    t.vout.forEach((o, i) => { if (i !== k && o.value > 330 && o.scriptpubkey_address === esc.address) paid += BigInt(o.value); });
    if (paid > 0n) return paid;
  }
  const paid = { creator: 0n, flywheel: 0n, treasury: 0n };
  t.vout.forEach((o, i) => {
    if (i === k || !(o.value > 330)) return;
    const a = o.scriptpubkey_address;
    if (a === creator) paid.creator += BigInt(o.value);
    else if (a === c.net.addresses.protocolFee) paid.flywheel += BigInt(o.value);
    else if (a === c.net.addresses.treasury) paid.treasury += BigInt(o.value);
  });
  return [(paid.creator * 10000n) / SPLIT_BTC.creator, (paid.flywheel * 10000n) / SPLIT_BTC.flywheel, (paid.treasury * 10000n) / SPLIT_BTC.treasury]
    .reduce((m, v) => (v < m ? v : m));
}

export function applyTokenMint(c: Ctx, t: Tx, height: number, mk: Marker) {
  const dep = deployOf(c, mk.tick);
  if (!dep || dep.target_sats == null || !dep.cmr) return;            // only bonding tokens
  const capital = btcPurchaseCapital(c, t, mk.k, dep.creator, height);
  if (capital <= 0n) return;
  if (launchStatus(dep, getMintedAtoms(c.db, mk.tick), height) !== "minting") return;
  const payer = t.vin[0]?.prevout?.scriptpubkey_address ?? null;
  const allocCov = covenantOfWallet(payer, dep.cmr, c.btc);           // the payer's covenant under the token's contract
  if (!allocCov) return;
  const sealVout = t.vout.findIndex((o, i) => i !== mk.k && o.value === 330 && o.scriptpubkey_address === allocCov);
  if (sealVout < 0) return;
  const q = quoteLaunch(BigInt(dep.target_sats), getMintedAtoms(c.db, mk.tick), capital * 1_000_000n);
  if (q.atoms <= 0n) return;
  q.atoms = walletCap(c, mk.tick, allocCov, q.atoms, height);
  if (q.atoms <= 0n) return;
  tx(c.db, () => {
    createSeal(c.db, { outpoint: `${t.txid}:${sealVout}`, tick: mk.tick, txid: t.txid, vout: sealVout, height, owner_address: allocCov,
      amount_atoms: q.atoms, kind: "allocation", bucket: "public" });
    addMintedAtoms(c.db, q.atoms, mk.tick);
    addRaiseSats(c.db, capital, mk.tick, height, t.txid);
    try { if (payer) linkCovenantOwner(c, allocCov, ownerKeyFromAddress(payer, c.btc), "payer", dep.cmr ?? undefined); } catch { /* not taproot */ }
    delta(c.db, height, t.txid, `mint:${mk.tick}`, null, allocCov, q.atoms);
  });
}

/* ── bonding token, paid in BONS (three markers, one transaction) ─────────────────────────────────────────────────── */

export interface BonsPurchaseShape { transfers: [Marker, Marker]; mint: Marker; tick: string }

/** transfer BONS + transfer BONS + mint TOKEN (exactly three markers, in that order) */
export function bonsPurchaseShape(markers: Marker[]): BonsPurchaseShape | null {
  if (markers.length !== 3) return null;
  const [a, b, m] = markers as [Marker, Marker, Marker];
  if (a.m.op !== "transfer" || b.m.op !== "transfer" || m.m.op !== "mint") return null;
  if (a.tick !== TICK || b.tick !== TICK || m.tick === TICK) return null;
  return { transfers: [a, b], mint: m, tick: m.tick };
}

/** The tokens bought, once the two BONS transfers have settled as an ordinary batch (`plans`). */
export function applyBonsPurchase(c: Ctx, t: Tx, height: number, shape: BonsPurchaseShape,
  plans: { seal: Seal; vin: { witness?: string[] }; amt: bigint; recvAddress: string }[]) {
  if (plans.length !== 2) return;
  const [pb, pt] = plans as [typeof plans[0], typeof plans[0]];
  const dep = deployOf(c, shape.tick);
  if (!dep || dep.target_sats == null || !dep.cmr) return;
  if (pb.seal.tick !== TICK || pt.seal.tick !== TICK || pb.seal.owner_address !== pt.seal.owner_address) return;
  const hold = c.net.addresses.launchPreburnCovenant;
  const holdOn = !!hold && height >= hold.from;
  // 80%: the burn covenant — or, from its height, the pre-burn holding
  if (pb.recvAddress !== c.burnCovenant && !(holdOn && pb.recvAddress === hold!.covenant)) return;
  // 20%: the treasury's BONS covenant — or, from its height, also the pre-burn holding
  if (pt.recvAddress !== c.treasuryCovenant && !(holdOn && pt.recvAddress === hold!.covenant)) return;
  const P = pb.amt + pt.amt, treasuryPart = (P * 2000n) / 10000n;
  if (pb.amt !== P - treasuryPart || pt.amt !== treasuryPart) return;
  const k = shape.mint.k, alloc = t.vout[k + 1];
  if (!alloc || alloc.value !== 330 || alloc.scriptpubkey_type !== "v1_p2tr" || !alloc.scriptpubkey_address) return;
  const w = pb.vin.witness ?? [];
  const payKey = w.length >= 2 ? ownerFromLeaf(w[w.length - 2]!) : null;
  if (!payKey || alloc.scriptpubkey_address !== deriveCovenant(payKey, dep.cmr, c.btc).address) return;
  if (launchStatus(dep, getMintedAtoms(c.db, dep.tick), height) !== "minting") return;
  const q = quoteLaunch(BigInt(dep.target_sats), getMintedAtoms(c.db, dep.tick), bonsBudgetMicroSats(JSON.parse(dep.rate_json), P));
  if (q.atoms <= 0n) return;
  q.atoms = walletCap(c, dep.tick, alloc.scriptpubkey_address, q.atoms, height);
  if (q.atoms <= 0n) return;
  tx(c.db, () => {
    createSeal(c.db, { outpoint: `${t.txid}:${k + 1}`, tick: dep.tick, txid: t.txid, vout: k + 1, height, owner_address: alloc.scriptpubkey_address!,
      amount_atoms: q.atoms, kind: "allocation", bucket: "public" });
    addMintedAtoms(c.db, q.atoms, dep.tick);
    linkCovenantOwner(c, alloc.scriptpubkey_address!, payKey, "payer", dep.cmr ?? undefined);
    delta(c.db, height, t.txid, `mint:${dep.tick}`, null, alloc.scriptpubkey_address!, q.atoms);
  });
  void one; void BONS_CMR;
}
