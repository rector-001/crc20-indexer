// The two consensus curves. All integer maths (BigInt), ported unchanged from crc20-stack src/curve.mjs and
// src/launchpad.mjs.
//
// BONS curve: two slopes over 21,000,000 BONS, priced in USD at the block's BTC/USD:
//   opening slope — the first 10% (2,100,000 BONS) flat, $200 across the whole slope; taken by mints paid from the
//                   network's `curveOpeningPayer` address
//   linear slope  — p0 -> 4·p0 over the other 90%, p0 = 2·$35,000 / (5 · 18,900,000); each mint priced at the spot price
//                   of the supply already minted on this slope (a snapshot, not the area)
// Bonding-token curve: p0 -> 4·p0 over 1,000,000,000 tokens, each purchase paying the exact AREA, in sats (micro-sats).

export const ONE = 100_000_000n;                 // atoms per whole token
const USD1 = 1_000_000n;                         // micro-USD per USD

/** oracle "priceUsd" (decimal string) -> integer micro-USD per BTC. Throws on a malformed value. */
export function usdMicrosPerBtc(priceUsd: string): bigint {
  const s = String(priceUsd).trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(s)) throw new Error("bad oracle price");
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * USD1 + BigInt((f + "000000").slice(0, 6));
}

export interface BonsCurve { max: bigint; openingBps: bigint; openingTotalUsd: number; targetUsd: number; endMultiple: bigint }
export const bonsCurve = (max: bigint): BonsCurve => ({ max, openingBps: 1000n, openingTotalUsd: 200, targetUsd: 35_000, endMultiple: 4n });

export function curveParams(d: BonsCurve) {
  const openingTokens = (d.max * d.openingBps) / 10000n;
  const publicTokens = d.max - openingTokens;
  const targetMicros = BigInt(Math.round(d.targetUsd * 1e6));
  const p0 = publicTokens > 0n ? (2n * targetMicros) / ((1n + d.endMultiple) * publicTokens) : 0n;
  const p1 = p0 * d.endMultiple;
  const openingTotalMicros = BigInt(Math.round(d.openingTotalUsd * 1e6));
  const openingPrice = openingTokens > 0n ? openingTotalMicros / openingTokens : 0n;
  return { maxAtoms: d.max * ONE, openingAtoms: openingTokens * ONE, publicAtoms: publicTokens * ONE, openingTotalMicros, openingPrice, p0, p1 };
}

/** linear-slope spot price (micro-USD per whole token) at a given public minted supply */
export function spotPriceUsdMicros(publicMintedAtoms: bigint, d: BonsCurve): bigint {
  const { publicAtoms, p0, p1 } = curveParams(d);
  if (publicAtoms === 0n) return p0;
  const span = publicMintedAtoms > publicAtoms ? publicAtoms : publicMintedAtoms;
  return p0 + ((p1 - p0) * span) / publicAtoms;
}

export interface BonsQuote { allocatedAtoms: bigint; status: string; priceUsdMicros: bigint; slope?: "opening" | "public" }

/** A BONS mint of `sats` at `btcUsd`, given what is already minted on each slope. */
export function quoteBonsMint(p: { sats: bigint; btcUsd: string; publicMinted: bigint; openingMinted: bigint; onOpening: boolean; curve: BonsCurve }): BonsQuote {
  const { openingAtoms, publicAtoms, openingPrice, openingTotalMicros } = curveParams(p.curve);
  const budget = (p.sats * usdMicrosPerBtc(p.btcUsd)) / ONE;          // sats -> micro-USD
  if (p.onOpening && openingAtoms > 0n) {
    const remaining = openingAtoms - p.openingMinted;
    if (remaining <= 0n) return { allocatedAtoms: 0n, status: "opening_exhausted", priceUsdMicros: openingPrice };
    let atoms = openingTotalMicros > 0n ? (budget * openingAtoms) / openingTotalMicros : 0n;
    let status = "allocated";
    if (atoms > remaining) { atoms = remaining; status = "clamped"; }
    if (atoms <= 0n) return { allocatedAtoms: 0n, status: "reserve_exhausted", priceUsdMicros: openingPrice };
    return { allocatedAtoms: atoms, status, priceUsdMicros: openingPrice, slope: "opening" };
  }
  const remaining = publicAtoms - p.publicMinted;
  if (remaining <= 0n) return { allocatedAtoms: 0n, status: "reserve_exhausted", priceUsdMicros: 0n };
  const price = spotPriceUsdMicros(p.publicMinted, p.curve);
  if (price <= 0n) return { allocatedAtoms: 0n, status: "reserve_exhausted", priceUsdMicros: 0n };
  let atoms = (budget * ONE) / price;
  let status = "allocated";
  if (atoms > remaining) { atoms = remaining; status = "clamped"; }
  if (atoms <= 0n) return { allocatedAtoms: 0n, status: "reserve_exhausted", priceUsdMicros: price };
  return { allocatedAtoms: atoms, status, priceUsdMicros: price, slope: "public" };
}

/* ── launch curve ─────────────────────────────────────────────────────────────────────────────────────────────────── */

export const LAUNCH_ATOMS = 1_000_000_000n * ONE;
export const RATE_NUM = 250_000_000_000_000_000n;            // 2.5e17: target_sats = RATE_NUM / rate_btc
export const parseRate = (v: unknown): bigint | null => (/^[1-9][0-9]{0,30}$/.test(String(v ?? "")) ? BigInt(String(v)) : null);
export const targetSatsOfRate = (rateBtc: bigint): bigint => RATE_NUM / rateBtc;

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) + 1n;
  while (x * x > n) x = (x + n / x) >> 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** micro-units to buy `atoms` from minted supply x, rounded UP (splitting a buy never undercuts the curve) */
export function launchCost(target: bigint, mintedAtoms: bigint, atoms: bigint): bigint {
  const A = LAUNCH_ATOMS, T = target * 1_000_000n, x = mintedAtoms, d = atoms;
  const num = T * (2n * A * d + 6n * x * d + 3n * d * d), den = 5n * A * A;
  return (num + den - 1n) / den;
}

export interface LaunchQuote { atoms: bigint; status: "sold_out" | "clamped" | "allocated" | "too_small"; costMicros: bigint }
/** atoms a budget (micro-units) buys at minted supply x; clamped to what is left */
export function quoteLaunch(target: bigint, mintedAtoms: bigint, budgetMicros: bigint): LaunchQuote {
  const A = LAUNCH_ATOMS, T = target * 1_000_000n, x = mintedAtoms, B = budgetMicros;
  const remaining = A - x;
  if (remaining <= 0n || B <= 0n || T <= 0n) return { atoms: 0n, status: "sold_out", costMicros: 0n };
  const b = 2n * A + 6n * x;
  let d = (isqrt(b * b + (60n * A * A * B) / T) - b) / 6n;
  while (d > 0n && launchCost(target, x, d) > B) d -= 1n;
  if (d >= remaining) return { atoms: remaining, status: "clamped", costMicros: launchCost(target, x, remaining) };
  return { atoms: d, status: d > 0n ? "allocated" : "too_small", costMicros: launchCost(target, x, d) };
}

/** A BONS payment's value in the launch curve's unit (micro-sats), from the deploy's fixed rates */
export function bonsBudgetMicroSats(rates: { btc: string; bons: string }, bonsAtoms: bigint): bigint {
  const rb = parseRate(rates.btc), rn = parseRate(rates.bons);
  if (!rb || !rn) return 0n;
  return (bonsAtoms * rn * 1_000_000n) / rb;
}
