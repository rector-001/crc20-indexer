// The canonical ledger dump: every consensus table in a fixed order with fixed sorting, one JSON row per line, and the
// sha256 of it all. Two honest nodes at the same height produce the same bytes (`crc20 index export`).
import { createHash } from "node:crypto";
import { all, getCursor, type Db } from "./ledger.js";

export const EXPORT_TABLES: [string, string][] = [
  ["deploy", "tick"], ["other_deploys", "txid"], ["seals", "outpoint"], ["balances", "tick, address"],
  ["deltas", "id"], ["pob_used", "burn_txid"], ["bons_fills", "txid"], ["amm_pools", "tick"], ["amm_positions", "txid"],
  ["meta", "k"], ["blocks", "height"], ["oracle", "height"],
];

export function exportLedger(db: Db): { cursor: number | null; sha256: string; rows: number; lines: string[] } {
  const h = createHash("sha256"), lines: string[] = [];
  for (const [table, order] of EXPORT_TABLES)
    for (const r of all<Record<string, unknown>>(db, `SELECT * FROM ${table} ORDER BY ${order}`)) {
      const line = `${table}\t${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
      h.update(line + "\n"); lines.push(line);
    }
  return { cursor: getCursor(db), sha256: h.digest("hex"), rows: lines.length, lines };
}
