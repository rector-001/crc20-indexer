// Which ONE rule settles a transaction — the reference indexer's order (crc20-stack src/indexer.mjs applyTx):
//   1. resting TOKEN/BONS offers (bound triples)     — whatever else the transaction carries
//   2. curve-pool operation (amm-*)                  — a malformed one moves nothing
//   3. sp-transfer (amt is a list)                   — an invalid one moves nothing
//   4. merge (2+ coins of one token, amt = their total)
//   5. the FIRST marker's op: deploy · mint · transfer (BONS-paid purchase → batch / multi-split → single)
// A rule that is pending on this network (constants) is skipped as if it did not exist.
import { markersOf } from "./message.js";
import { TICK, type Ctx } from "./context.js";
import { applyPool, poolShape } from "./pool.js";
import { ammShape, applyAmm } from "./amm.js";
import { applyMerge, applyMultiSplit, applySingleTransfer, applySpTransfer, batchShape, commitBatch, mergeShape, planBatch, sealsIn, spTransferShape } from "./transfer.js";
import { applyDeploy } from "./deploy.js";
import { applyBonsMint, applyBonsPurchase, applyTokenMint, bonsPurchaseShape } from "./mint.js";
import type { Tx } from "./types.js";

export function applyTx(c: Ctx, t: Tx, height: number, btcUsd: string): void {
  const markers = markersOf(t);
  if (!markers.length) return;

  const pool = poolShape(c, t, height, markers);
  if (pool) return applyPool(c, t, height, pool);
  const amm = ammShape(c, t, height, markers);
  if (amm) return "invalid" in amm ? undefined : applyAmm(c, t, height, amm);
  const sp = spTransferShape(c, t, height, markers);
  if (sp) return "invalid" in sp ? undefined : applySpTransfer(c, t, height, sp);
  const merge = mergeShape(c, t, height, markers);
  if (merge) return applyMerge(c, t, height, merge);

  const first = markers[0]!;
  if (first.m.op === "deploy") return applyDeploy(c, t, height, first, btcUsd);
  if (first.m.op === "mint") return first.tick === TICK ? applyBonsMint(c, t, height, first, btcUsd) : applyTokenMint(c, t, height, first);
  if (first.m.op !== "transfer") return;

  // a bonding token bought with BONS: two BONS transfers (settled as a batch, which always stands) + the token's mint marker
  const purchase = bonsPurchaseShape(markers);
  if (purchase) {
    const seals = sealsIn(c, t);
    if (seals.length !== 2) return;
    const plans = planBatch(c, t, purchase.transfers, seals);
    if (!plans) return;
    commitBatch(c, t, height, plans);
    return applyBonsPurchase(c, t, height, purchase, plans.map((p) => ({ seal: p.seal, vin: p.vin, amt: p.amt, recvAddress: p.recv.scriptpubkey_address })));
  }
  const batch = batchShape(c, t, height, markers);
  if (batch) {
    if (batch.multiSplit) return applyMultiSplit(c, t, height, batch.markers, batch.seals[0]!);
    const plans = planBatch(c, t, batch.markers, batch.seals);
    if (plans) commitBatch(c, t, height, plans);
    return;
  }
  return applySingleTransfer(c, t, height, first);
}
