// Read queries behind the /v1 API (docs/API.md). Everything here reads the ledger; nothing writes.
import * as bitcoin from "bitcoinjs-lib";
import { all, one, getMeta, getCursor, getBlockHash, type Db } from "../store/ledger.js";
import { BONS_CMR, controlBlockOf, deriveCovenant, ownerKeyFromAddress } from "../protocol/covenant.js";
import { ONE, curveParams } from "../protocol/curve.js";
import { TICK, type Ctx } from "../protocol/context.js";
import { LAUNCH_CLOSE_BLOCKS, launchStatus, type DeployRow } from "../protocol/tokens.js";
import { getMintedAtoms } from "../store/ledger.js";

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const DEC = 8;
const big = (v: unknown) => BigInt(String(v ?? "0"));

/* ── tokens ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Indexed tokens: BONS and every bonding token (a deploy with its own contract). */
export function tokenRows(c: Ctx): DeployRow[] {
  return all<DeployRow>(c.db, "SELECT * FROM deploy WHERE tick = ? OR cmr IS NOT NULL ORDER BY height, tick", TICK);
}
export function tokenRow(c: Ctx, tick: string): DeployRow {
  const t = tick.toUpperCase();
  const d = one<DeployRow>(c.db, "SELECT * FROM deploy WHERE tick = ? AND (tick = ? OR cmr IS NOT NULL)", t, TICK);
  if (!d) throw new ApiError(404, "not_found", `No token ${t} on this chain.`);
  return d;
}
const contractOf = (d: DeployRow) => (d.tick === TICK ? BONS_CMR : d.cmr!);
const heldAtSinks = (c: Ctx, tick: string) =>
  big(one<{ s: string | null }>(c.db, `SELECT CAST(SUM(CAST(atoms AS INTEGER)) AS TEXT) s FROM balances WHERE tick = ? AND address IN (${c.sinks.map(() => "?").join(",")})`, tick, ...c.sinks)?.s);

function supply(c: Ctx, d: DeployRow) {
  const max = d.tick === TICK ? curveParams(c.curve).maxAtoms : big(d.max) * ONE;
  const minted = getMintedAtoms(c.db, d.tick);
  const burned = big(getMeta(c.db, `burned_atoms:${d.tick}`, "0")) + heldAtSinks(c, d.tick);
  return { max: max.toString(), minted: minted.toString(), burned: burned.toString(), circulating: (minted - burned).toString() };
}
function holderCount(c: Ctx, tick: string): number {
  return one<{ n: number }>(c.db, `SELECT COUNT(*) n FROM balances WHERE tick = ? AND atoms <> '0' AND address NOT IN (${c.sinks.map(() => "?").join(",")})`, tick, ...c.sinks)!.n;
}
function status(c: Ctx, d: DeployRow): string {
  if (d.tick === TICK) return getMintedAtoms(c.db, TICK) >= curveParams(c.curve).maxAtoms ? "complete" : "minting";
  return launchStatus(d, getMintedAtoms(c.db, d.tick), (getCursor(c.db) ?? 0));
}

export function tokenSummary(c: Ctx, d: DeployRow) {
  const s = supply(c, d);
  return { tick: d.tick, kind: d.tick === TICK ? "bons" : "bonding", decimals: DEC, max_supply: s.max, minted: s.minted, burned: s.burned,
    circulating: s.circulating, holders: holderCount(c, d.tick), deploy_txid: d.deploy_txid, deploy_height: d.height, contract: contractOf(d), status: status(c, d) };
}

export function tokenDetail(c: Ctx, tick: string) {
  const d = tokenRow(c, tick), rates = JSON.parse(d.rate_json || "{}");
  const base = tokenSummary(c, d);
  if (d.tick === TICK) {
    const p = curveParams(c.curve);
    return { ...base, deploy: { txid: d.deploy_txid, height: d.height, creator: d.creator },
      curve: { slopes: [
        { name: "opening", tokens: (p.openingAtoms / ONE).toString(), total_usd: "200", flat: true },
        { name: "linear", tokens: (p.publicAtoms / ONE).toString(), start_usd_micros: p.p0.toString(), end_usd_micros: p.p1.toString() }],
        priced: "spot price of the supply minted on its slope, at the block's BTC/USD" },
      raised_sats: getMeta(c.db, `raise:${TICK}`, "0") };
  }
  return { ...base,
    deploy: { txid: d.deploy_txid, height: d.height, creator: d.creator, proof_of_burn_txid: d.pob_txid,
      marker: { p: "crc-20", op: "deploy", tick: d.tick, type: "bonding", max: d.max, lim: d.lim, btc: rates.btc, bons: rates.bons } },
    curve: { shape: "linear", start_to_end: 4, priced: "exact area, in sats", target_sats: d.target_sats, rates },
    raise: { status: base.status, raised_sats: getMeta(c.db, `raise:${d.tick}`, "0"), closes_at_height: d.height + LAUNCH_CLOSE_BLOCKS, target_usd: d.target_usd } };
}

const ownerOf = (c: Ctx, cov: string) => one<{ wallet_address: string; owner_xonly: string; source: string }>(c.db, "SELECT wallet_address, owner_xonly, source FROM covenant_owners WHERE covenant_address = ?", cov);

export function holders(c: Ctx, tick: string, limit: number, offset: number, withCoins: boolean) {
  const d = tokenRow(c, tick);
  const circ = big(supply(c, d).circulating);
  const rows = all<{ address: string; atoms: string }>(c.db,
    `SELECT address, atoms FROM balances WHERE tick = ? AND atoms <> '0' AND address NOT IN (${c.sinks.map(() => "?").join(",")})
     ORDER BY CAST(atoms AS INTEGER) DESC, address LIMIT ? OFFSET ?`, d.tick, ...c.sinks, limit + 1, offset);
  const items = rows.slice(0, limit).map((r) => {
    const o = ownerOf(c, r.address);
    return { owner: o?.wallet_address ?? null, covenant: r.address, balance: r.atoms,
      share: circ > 0n ? (Number((big(r.atoms) * 1_000_000n) / circ) / 1e6).toFixed(6) : "0",
      coins: one<{ n: number }>(c.db, "SELECT COUNT(*) n FROM seals WHERE tick = ? AND owner_address = ? AND status = 'active'", d.tick, r.address)!.n,
      ...(withCoins ? { coin_list: coinRows(c, [r.address], d.tick) } : {}) };
  });
  return { items, next_cursor: rows.length > limit ? String(offset + limit) : null };
}

/* ── activity (deltas) ─────────────────────────────────────────────────────────────────────────────────────────────── */

interface Delta { id: number; height: number; txid: string; op: string; from_addr: string | null; to_addr: string | null; atoms: string }
const OP_NAMES: Record<string, string> = { mint: "mint", transfer: "transfer", burn: "burn", merge: "merge" };
function activityItem(c: Ctx, r: Delta, tip: number, mine?: Set<string>) {
  const [op, tick] = r.op.split(":") as [string, string];
  const fromMine = mine && r.from_addr ? mine.has(r.from_addr) : false, toMine = mine && r.to_addr ? mine.has(r.to_addr) : false;
  const side = (a: string | null) => (a ? { covenant: a, owner: ownerOf(c, a)?.wallet_address ?? null } : null);
  return { txid: r.txid, height: r.height, block_hash: getBlockHash(c.db, r.height), confirmations: tip - r.height + 1, op: OP_NAMES[op] ?? op, tick,
    amount: r.atoms, from: side(r.from_addr), to: side(r.to_addr),
    ...(mine ? { direction: fromMine && toMine ? "self" : toMine ? "in" : "out" } : {}) };
}
const tipOf = (c: Ctx) => (getCursor(c.db) ?? 1) - 1;
/** Token-moving events only (no "raise:" bookkeeping rows). */
const MOVES = "(op LIKE 'mint:%' OR op LIKE 'transfer:%' OR op LIKE 'burn:%' OR op LIKE 'merge:%')";

export function tokenActivity(c: Ctx, tick: string, limit: number, before: number | null) {
  const d = tokenRow(c, tick);
  const rows = all<Delta>(c.db, `SELECT * FROM deltas WHERE op IN (?, ?, ?, ?) AND id < ? ORDER BY id DESC LIMIT ?`,
    `mint:${d.tick}`, `transfer:${d.tick}`, `burn:${d.tick}`, `merge:${d.tick}`, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const tip = tipOf(c);
  return { items: rows.slice(0, limit).map((r) => activityItem(c, r, tip)), next_cursor: rows.length > limit ? String(rows[limit - 1]!.id) : null };
}

/* ── addresses: wallet or covenant ─────────────────────────────────────────────────────────────────────────────────── */

export interface Resolved { address: string; kind: "wallet" | "covenant"; ownerKey: string | null; covenants: { tick: string; covenant: string; contract: string }[] }

/** A WALLET address (Taproot, or any type with ?public_key) -> its covenant for every token; a COVENANT -> itself. */
export function resolve(c: Ctx, address: string, publicKey?: string | null): Resolved {
  const asCov = all<{ tick: string }>(c.db, "SELECT DISTINCT tick FROM seals WHERE owner_address = ?", address);
  if (asCov.length) {
    const o = ownerOf(c, address);
    return { address, kind: "covenant", ownerKey: o?.owner_xonly ?? null,
      covenants: asCov.map((r) => ({ tick: r.tick, covenant: address, contract: r.tick === TICK ? BONS_CMR : (tokenRow(c, r.tick).cmr ?? "") })) };
  }
  let key: string;
  try {
    if (publicKey) {
      const k = Buffer.from(publicKey, "hex");
      if (!(k.length === 32 || (k.length === 33 && (k[0] === 2 || k[0] === 3)))) throw new Error("bad key");
      key = (k.length === 33 ? k.subarray(1) : k).toString("hex");
    } else key = ownerKeyFromAddress(address, c.btc);
  } catch {
    try { bitcoin.address.toOutputScript(address, c.btc); } catch { throw new ApiError(400, "invalid_address", `Not an address on ${c.net.name}.`); }
    throw new ApiError(400, "public_key_required", "This is not a Taproot address: pass ?public_key=<hex> so its covenants can be derived.");
  }
  return { address, kind: "wallet", ownerKey: key,
    covenants: tokenRows(c).map((d) => ({ tick: d.tick, covenant: deriveCovenant(key, contractOf(d), c.btc).address, contract: contractOf(d) })) };
}

function coinRows(c: Ctx, covenants: string[], tick?: string) {
  if (!covenants.length) return [];
  const rows = all<{ outpoint: string; tick: string; amount_atoms: string; owner_address: string; height: number; kind: string }>(c.db,
    `SELECT outpoint, tick, amount_atoms, owner_address, height, kind FROM seals WHERE status = 'active' AND owner_address IN (${covenants.map(() => "?").join(",")})
     ${tick ? "AND tick = ?" : ""} ORDER BY height, outpoint`, ...covenants, ...(tick ? [tick] : []));
  return rows;
}

export function balances(c: Ctx, r: Resolved) {
  const items = r.covenants.map((cv) => {
    const row = one<{ atoms: string }>(c.db, "SELECT atoms FROM balances WHERE tick = ? AND address = ?", cv.tick, cv.covenant);
    const n = one<{ n: number }>(c.db, "SELECT COUNT(*) n FROM seals WHERE tick = ? AND owner_address = ? AND status = 'active'", cv.tick, cv.covenant)!.n;
    return { tick: cv.tick, decimals: DEC, covenant: cv.covenant, confirmed: row?.atoms ?? "0", coins: n };
  }).filter((x) => r.kind === "covenant" || x.confirmed !== "0");
  return { address: r.address, kind: r.kind, owner_key: r.ownerKey, items };
}

export function coins(c: Ctx, r: Resolved, tick?: string) {
  const byCov = new Map(r.covenants.map((cv) => [cv.covenant + ":" + cv.tick, cv]));
  const rows = coinRows(c, [...new Set(r.covenants.map((cv) => cv.covenant))], tick?.toUpperCase());
  return { items: rows.filter((x) => byCov.has(x.owner_address + ":" + x.tick)).map((x) => {
    const cv = byCov.get(x.owner_address + ":" + x.tick)!;
    const key = r.ownerKey ?? ownerOf(c, x.owner_address)?.owner_xonly ?? null;
    return { outpoint: x.outpoint, tick: x.tick, amount: x.amount_atoms, value_sats: 330, covenant: x.owner_address, kind: x.kind, height: x.height,
      owner_key: key,
      spend: key ? { leaf_script: deriveCovenant(key, cv.contract, c.btc).leafScriptHex, leaf_version: 0xc0, control_block: controlBlockOf(key, cv.contract, c.btc) } : null };
  }) };
}

export function covenants(c: Ctx, r: Resolved) {
  if (!r.ownerKey) return { owner_key: null, items: r.covenants.map((cv) => ({ tick: cv.tick, contract: cv.contract, covenant: cv.covenant })) };
  return { owner_key: r.ownerKey, items: r.covenants.map((cv) => ({ tick: cv.tick, contract: cv.contract, covenant: cv.covenant,
    leaf_script: deriveCovenant(r.ownerKey!, cv.contract, c.btc).leafScriptHex, control_block: controlBlockOf(r.ownerKey!, cv.contract, c.btc) })) };
}

export function addressActivity(c: Ctx, r: Resolved, limit: number, before: number | null, tick?: string) {
  const covs = [...new Set(r.covenants.filter((cv) => !tick || cv.tick === tick.toUpperCase()).map((cv) => cv.covenant))];
  if (!covs.length) return { items: [], next_cursor: null };
  const ph = covs.map(() => "?").join(",");
  const rows = all<Delta>(c.db, `SELECT * FROM deltas WHERE ${MOVES} AND (from_addr IN (${ph}) OR to_addr IN (${ph})) AND id < ? ORDER BY id DESC LIMIT ?`,
    ...covs, ...covs, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const mine = new Set(covs), tip = tipOf(c);
  return { items: rows.slice(0, limit).filter((x) => !tick || x.op.endsWith(`:${tick.toUpperCase()}`)).map((x) => activityItem(c, x, tip, mine)),
    next_cursor: rows.length > limit ? String(rows[limit - 1]!.id) : null };
}

/** Outputs AT this address that hold tokens (a wallet that imported a covenant, or a covenant queried directly). */
export function protectedOutputs(c: Ctx, address: string) {
  return { items: all<{ outpoint: string; tick: string; amount_atoms: string }>(c.db, "SELECT outpoint, tick, amount_atoms FROM seals WHERE owner_address = ? AND status = 'active' ORDER BY outpoint", address)
    .map((x) => ({ outpoint: x.outpoint, reason: "token_coin", tick: x.tick, amount: x.amount_atoms })) };
}

/* ── outputs, transactions, blocks, events ─────────────────────────────────────────────────────────────────────────── */

interface SealRow { outpoint: string; tick: string; txid: string; vout: number; height: number; owner_address: string; amount_atoms: string; kind: string; status: string; spent_txid: string | null }
export function output(c: Ctx, outpoint: string) {
  if (!/^[0-9a-f]{64}:\d+$/.test(outpoint)) throw new ApiError(400, "invalid_outpoint", "Use <txid>:<vout>.");
  const s = one<SealRow>(c.db, "SELECT * FROM seals WHERE outpoint = ?", outpoint);
  return { outpoint, token: s ? { tick: s.tick, amount: s.amount_atoms, status: s.status, kind: s.kind, covenant: s.owner_address,
    owner: ownerOf(c, s.owner_address)?.wallet_address ?? null, created: { txid: s.txid, height: s.height }, spent_by: s.spent_txid } : null };
}

export function transaction(c: Ctx, txid: string) {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new ApiError(400, "invalid_txid", "A txid is 64 hex characters.");
  const deltas = all<Delta>(c.db, "SELECT * FROM deltas WHERE txid = ? ORDER BY id", txid);
  const spent = all<SealRow>(c.db, "SELECT * FROM seals WHERE spent_txid = ? ORDER BY outpoint", txid);
  const created = all<SealRow>(c.db, "SELECT * FROM seals WHERE txid = ? ORDER BY vout", txid);
  if (!deltas.length && !spent.length && !created.length) throw new ApiError(404, "not_found", "This node saw no CRC-20 effect from that transaction (unknown, unconfirmed, or nothing moved).");
  const ops = new Set(deltas.map((d) => d.op.split(":")[0]));
  const rule = ops.has("mint") && ops.has("transfer") ? "launch_purchase" : ops.has("mint") ? "mint" : ops.has("merge") ? "merge"
    : spent.length > 1 ? "batch" : ops.has("transfer") || ops.has("burn") ? "transfer" : "none";
  const height = deltas[0]?.height ?? created[0]?.height ?? null;
  return { txid, height, block_hash: height != null ? getBlockHash(c.db, height) : null, rule, valid: true,
    spent: spent.map((s) => ({ outpoint: s.outpoint, tick: s.tick, amount: s.amount_atoms, covenant: s.owner_address })),
    created: created.map((s) => ({ outpoint: s.outpoint, tick: s.tick, amount: s.amount_atoms, covenant: s.owner_address, kind: s.kind })),
    burned: deltas.filter((d) => d.op.startsWith("burn:")).map((d) => ({ tick: d.op.slice(5), amount: d.atoms, to: d.to_addr })) };
}

export function block(c: Ctx, height: number) {
  const hash = getBlockHash(c.db, height);
  if (!hash) throw new ApiError(404, "not_found", "That height is not indexed.");
  const tip = tipOf(c);
  return { height, hash, events: all<Delta>(c.db, `SELECT * FROM deltas WHERE height = ? AND ${MOVES} ORDER BY id`, height).map((r) => activityItem(c, r, tip)) };
}

export function events(c: Ctx, from: number, to: number, tick: string | undefined, limit: number, after: number | null) {
  const rows = all<Delta>(c.db, `SELECT * FROM deltas WHERE ${MOVES} AND height >= ? AND height <= ? ${tick ? "AND op LIKE ?" : ""} AND id > ? ORDER BY id LIMIT ?`,
    from, to, ...(tick ? [`%:${tick.toUpperCase()}`] : []), after ?? 0, limit + 1);
  const tip = tipOf(c);
  return { items: rows.slice(0, limit).map((r) => ({ index: r.id, ...activityItem(c, r, tip) })), next_cursor: rows.length > limit ? String(rows[limit - 1]!.id) : null };
}

export function statusOf(c: Ctx, chainTip: number | null, version: string, pinned: Record<string, string>) {
  const h = tipOf(c);
  return { network: c.net.name === "bitcoin" ? "mainnet" : c.net.name, version, protocol: "crc-20", indexed_height: h, indexed_hash: getBlockHash(c.db, h),
    chain_tip: chainTip, synced: chainTip != null && h >= chainTip, first_block: c.net.deployBlock, pinned };
}

export function rules(c: Ctx) {
  const a = c.net.addresses;
  return { network: c.net.name === "bitcoin" ? "mainnet" : c.net.name, first_block: c.net.deployBlock,
    contracts: { BONS: BONS_CMR }, bonding_contract: "sha256(\"crc-20:<TICK>:v1:bonding:max=1000000000:no-timelock:<deploy txid>\")",
    burn_sinks: c.sinks, activations: c.net.activations,
    addresses: { treasury: a.treasury, curve_opening_payer: a.curveOpeningPayer, flywheel: a.protocolFee, holding: a.launchEscrow, preburn: a.launchPreburnCovenant },
    bonding: { supply: "1000000000", raise_closes_after_blocks: LAUNCH_CLOSE_BLOCKS, split_btc_bps: { creator: 4500, flywheel: 4500, treasury: 1000 }, split_bons_bps: { burn: 8000, treasury: 2000 } } };
}
