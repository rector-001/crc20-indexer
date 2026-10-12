// Which ONE rule settles a transaction — the reference indexer's order (crc20-stack src/indexer.mjs applyTx):
//   1. merge (2+ coins of one token, amt = their total), from its activation
//   2. the FIRST marker's op: deploy · mint · transfer (BONS-paid purchase → batch → single)
import { markersOf } from "./message.js";
import { TICK, type Ctx } from "./context.js";
import { applyMerge, applySingleTransfer, batchShape, commitBatch, mergeShape, planBatch, sealsIn } from "./transfer.js";
import { applyDeploy } from "./deploy.js";
import { applyBonsMint, applyBonsPurchase, applyTokenMint, bonsPurchaseShape } from "./mint.js";
import type { Tx } from "./types.js";

export function applyTx(c: Ctx, t: Tx, height: number, btcUsd: string): void {
  const markers = markersOf(t);
  if (!markers.length) return;

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
  const batch = batchShape(c, t, markers);
  if (batch) {
    const plans = planBatch(c, t, batch.markers, batch.seals);
    if (plans) commitBatch(c, t, height, plans);
    return;
  }
  return applySingleTransfer(c, t, height, first);
}
