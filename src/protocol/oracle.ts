// BTC/USD per block. Consensus needs it for the BONS mint (USD curve) and for launch deploys (raise range) and
// proof-of-burn (worth $20). Order, the same as the reference indexer's replay:
//   1. a pinned value for this height (shipped data, sha256-checked) — what the reference recorded live
//   2. a fixed price on regtest (tests)
//   3. the chain-derived UTXOracle: this block's consumer payments, median of the last 11 estimates
// UTXOracle below is ported constant for constant from crc20-stack src/utxoracle.mjs (itself a port of
// utxo.live/oracle/UTXOracle.py).
import type { Tx, TxIn } from "./types.js";
import { type Db, getOracle, putOracle, lastOracleAtOrBelow, recentOracleRaw } from "../store/ledger.js";

// ── histogram bins: [0.0] then 200 samples per 10x from 1e-6 to 1e5 BTC ─────────────────────────
const FIRST_BIN_VALUE = -6;
const LAST_BIN_VALUE = 6;
const RANGE_BIN_VALUES = LAST_BIN_VALUE - FIRST_BIN_VALUE;   // 12
const BINS: number[] = [0.0];
for (let exponent = -6; exponent < 6; exponent++) {
  for (let b = 0; b < 200; b++) BINS.push(10 ** (exponent + b / 200));
}
const NUM_BINS = BINS.length;                                 // 2401 (0.001 BTC lands at index 601)

// round-BTC bins (1k sats … 1 BTC) — smoothed out, since round-bitcoin sends aren't fiat-anchored
const ROUND_BTC_BINS = [201, 401, 461, 496, 540, 601, 661, 696, 740, 801, 861, 896, 940, 1001, 1061, 1096, 1140, 1201];

// ── stencils (803 elements each) ────────────────────────────────────────────────────────────────
const NUM_ELEMENTS = 803, MEAN = 411, STD_DEV = 201;
const SMOOTH_STENCIL: number[] = new Array(NUM_ELEMENTS);
for (let x = 0; x < NUM_ELEMENTS; x++) {
  const expPart = -((x - MEAN) ** 2) / (2 * STD_DEV ** 2);
  SMOOTH_STENCIL[x] = 0.0015 * Math.E ** expPart + 0.0000005 * x;
}
const SPIKE_STENCIL: number[] = new Array(NUM_ELEMENTS).fill(0.0);
// round-usd bin location / measured popularity / usd amount
SPIKE_STENCIL[40]  = 0.001300198324984352; // $1
SPIKE_STENCIL[141] = 0.001676746949820743; // $5
SPIKE_STENCIL[201] = 0.003468805546942046; // $10
SPIKE_STENCIL[202] = 0.001991977522512513;
SPIKE_STENCIL[236] = 0.001905066647961839; // $15
SPIKE_STENCIL[261] = 0.003341772718156079; // $20
SPIKE_STENCIL[262] = 0.002588902624584287;
SPIKE_STENCIL[296] = 0.002577893841190244; // $30
SPIKE_STENCIL[297] = 0.002733728814200412;
SPIKE_STENCIL[340] = 0.003076117748975647; // $50
SPIKE_STENCIL[341] = 0.005613067550103145;
SPIKE_STENCIL[342] = 0.003088253178535568;
SPIKE_STENCIL[400] = 0.002918457489366139; // $100
SPIKE_STENCIL[401] = 0.006174500465286022;
SPIKE_STENCIL[402] = 0.004417068070043504;
SPIKE_STENCIL[403] = 0.002628663628020371;
SPIKE_STENCIL[436] = 0.002858828161543839; // $150
SPIKE_STENCIL[461] = 0.004097463611984264; // $200
SPIKE_STENCIL[462] = 0.003345917406120509;
SPIKE_STENCIL[496] = 0.002521467726855856; // $300
SPIKE_STENCIL[497] = 0.002784125730361008;
SPIKE_STENCIL[541] = 0.003792850444811335; // $500
SPIKE_STENCIL[601] = 0.003688240815848247; // $1000
SPIKE_STENCIL[602] = 0.002392400117402263;
SPIKE_STENCIL[636] = 0.001280993059008106; // $1500
SPIKE_STENCIL[661] = 0.001654665137536031; // $2000
SPIKE_STENCIL[662] = 0.001395501347054946;
SPIKE_STENCIL[741] = 0.001154279140906312; // $5000
SPIKE_STENCIL[801] = 0.000832244504868709; // $10000

// slide window: zero slide means 0.001 BTC == $100 (i.e. a $100k price)
const CENTER_P001 = 601;
const LEFT_P001 = CENTER_P001 - Math.floor((NUM_ELEMENTS + 1) / 2);   // 199
const RIGHT_P001 = CENTER_P001 + Math.floor((NUM_ELEMENTS + 1) / 2);  // 1003
const MIN_SLIDE = -141;   // ≈ $500k
const MAX_SLIDE = 201;    // ≈ $5k
const SMOOTH_WEIGHT = 0.65;
const MIN_SAMPLES = 100;  // below this the histogram can't support a fit

/**
 * Estimate BTC/USD from consumer-payment output amounts, in BTC (not sats).
 * Feed it a DAY-SIZED window (~144 blocks) for reference accuracy.
 * @returns {{price:number|null, samples:number}}
 */
export function priceFromAmounts(amountsBtc: number[]): { price: number | null; samples: number } {
  const counts: number[] = new Array(NUM_BINS).fill(0.0);
  let samples = 0;
  for (const amount of amountsBtc) {
    if (!(amount > 1e-5 && amount < 1e5)) continue;             // reference bounds
    const amountLog = Math.log10(amount);
    const percentInRange = (amountLog - FIRST_BIN_VALUE) / RANGE_BIN_VALUES;
    let est = Math.floor(percentInRange * NUM_BINS);
    if (est < 0) est = 0; if (est >= NUM_BINS) est = NUM_BINS - 1;
    while (est < NUM_BINS && BINS[est]! <= amount) est += 1;      // walk up to the owning bin
    const bin = est - 1;
    if (bin >= 0 && bin < NUM_BINS) { counts[bin] = counts[bin]! + 1.0; samples += 1; }
  }
  if (samples < MIN_SAMPLES) return { price: null, samples };

  // smooth over the round-BTC bins (replace each with the mean of its neighbours)
  for (const r of ROUND_BTC_BINS) counts[r] = 0.5 * (counts[r + 1]! + counts[r - 1]!);

  // normalize bins 201..1600 by their sum, then cap extremes at 0.008
  let curveSum = 0.0;
  for (let n = 201; n < 1601; n++) curveSum += counts[n]!;
  if (!(curveSum > 0)) return { price: null, samples };
  for (let n = 201; n < 1601; n++) {
    counts[n] = counts[n]! / curveSum;
    if (counts[n]! > 0.008) counts[n] = 0.008;
  }

  // slide the stencil; score = spike correlation (+ weighted smooth term on the valid region)
  let bestSlide = 0, bestSlideScore = 0, totalScore = 0;
  const scoreAt = (slide: number, spikeOnly = false): number => {
    const off = LEFT_P001 + slide;
    let spike = 0.0, smooth = 0.0;
    for (let n = 0; n < NUM_ELEMENTS; n++) {
      const v = counts[off + n] || 0;
      spike += v * SPIKE_STENCIL[n]!;
      if (!spikeOnly) smooth += v * SMOOTH_STENCIL[n]!;
    }
    return spikeOnly ? spike : (slide < 150 ? spike + smooth * SMOOTH_WEIGHT : spike);
  };
  for (let slide = MIN_SLIDE; slide < MAX_SLIDE; slide++) {
    const s = scoreAt(slide);
    if (s > bestSlideScore) { bestSlideScore = s; bestSlide = slide; }
    totalScore += s;
  }

  const usd100InBtcBest = BINS[CENTER_P001 + bestSlide]!;
  if (!(usd100InBtcBest > 0)) return { price: null, samples };
  const btcInUsdBest = 100 / usd100InBtcBest;

  // refine using the better neighbouring slide (spike score only, as in the reference)
  const upScore = scoreAt(bestSlide + 1, true);
  const downScore = scoreAt(bestSlide - 1, true);
  const bestNeighbor = downScore > upScore ? -1 : 1;
  const neighborScore = Math.max(upScore, downScore);
  const usd100InBtc2nd = BINS[CENTER_P001 + bestSlide + bestNeighbor]!;
  const btcInUsd2nd = usd100InBtc2nd > 0 ? 100 / usd100InBtc2nd : btcInUsdBest;

  const avgScore = totalScore / (MAX_SLIDE - MIN_SLIDE);
  const a1 = bestSlideScore - avgScore;
  const a2 = Math.abs(neighborScore - avgScore);
  const w1 = a1 + a2 > 0 ? a1 / (a1 + a2) : 1;
  const w2 = a1 + a2 > 0 ? a2 / (a1 + a2) : 0;
  const price = Math.round(w1 * btcInUsdBest + w2 * btcInUsd2nd);
  return { price: price > 0 ? price : null, samples };
}

/* ---- output collection (applies the reference's consumer-payment filter) ---------------------- */

/** Does this Esplora-shaped input carry a witness item over 500 bytes? */
const witnessExceeds = (vin: TxIn): boolean => (vin.witness || []).some((w) => typeof w === "string" && w.length / 2 > 500);

/**
 * Collect qualifying output amounts (BTC) from Esplora-shaped txs — the indexer's path.
 * `windowTxids` is the set of txids in the same window, for the same-day/window filter.
 */
export function collectAmounts(txs: Tx[], windowTxids: Set<string> | null = null): number[] {
  const ids = windowTxids ?? new Set(txs.map((t) => t.txid));
  const out: number[] = [];
  for (const t of txs) {
    const vin = t.vin || [], vout = t.vout || [];
    if (vin.length > 5 || vout.length !== 2) continue;                 // consumer-payment shape
    if (vin[0]?.is_coinbase) continue;
    if (vout.some((o) => o.scriptpubkey_type === "op_return")) continue;
    if (vin.some(witnessExceeds)) continue;
    if (vin.some((i) => i.txid && ids.has(i.txid))) continue;          // same-window input
    for (const o of vout) {
      const btc = Number(o.value) / 1e8;
      if (btc > 1e-5 && btc < 1e5) out.push(btc);
    }
  }
  return out;
}


const ORACLE_MEDIAN_K = 11;

export interface OracleSource { pinned: Map<number, { price: string; samples: number }>; fixedUsd?: string | null }

/** BTC/USD for `height` (a decimal string), recorded in the ledger so the answer never changes on replay. */
export function oracleForHeight(db: Db, height: number, txs: Tx[], src: OracleSource): string {
  if (src.fixedUsd) return src.fixedUsd;
  const cached = getOracle(db, height);
  if (cached != null && Number(cached) > 0) return cached;
  const pin = src.pinned.get(height);
  if (pin) { putOracle(db, height, pin.price, pin.samples); return pin.price; }
  if (getOracle(db, height) == null) {
    const { price, samples } = priceFromAmounts(collectAmounts(txs));
    const raw = price != null ? String(price) : (lastOracleAtOrBelow(db, height) ?? "0");
    putOracle(db, height, raw, samples);
  }
  const recent = recentOracleRaw(db, height, ORACLE_MEDIAN_K);
  if (!recent.length) return lastOracleAtOrBelow(db, height) ?? "0";
  recent.sort((a, b) => a - b);
  return String(recent[recent.length >> 1]);
}
