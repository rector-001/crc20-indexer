// Reading a CRC-20 marker: an OP_RETURN output whose LAST push is UTF-8 JSON starting with "{", with p = "crc-20" and a
// tick of 2–8 letters or digits. Exactly the reference rule (crc20-stack src/util.mjs parseOpReturnJson + findMarker).
import * as bitcoin from "bitcoinjs-lib";
import type { Tx } from "./types.js";

export const PROTOCOL = "crc-20";
const TICK_RE = /^[A-Za-z0-9]{2,8}$/;

export type MarkerJson = Record<string, unknown> & { p?: unknown; op?: unknown; tick?: unknown; amt?: unknown };
export interface Marker { m: MarkerJson; k: number; tick: string }

/** The JSON an OP_RETURN script carries, or null. Never throws. */
export function parseOpReturnJson(scriptHex: string): MarkerJson | null {
  try {
    const buf = Buffer.from(scriptHex, "hex");
    if (buf[0] !== bitcoin.opcodes.OP_RETURN) return null;
    const chunks = bitcoin.script.decompile(buf);
    if (!chunks || chunks.length < 2) return null;
    const data = chunks[chunks.length - 1];
    if (!Buffer.isBuffer(data)) return null;
    const txt = data.toString("utf8");
    if (!txt.startsWith("{")) return null;
    const v = JSON.parse(txt);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as MarkerJson) : null;
  } catch { return null; }
}

/** Every CRC-20 marker of a transaction, in output order. */
export function markersOf(t: Tx): Marker[] {
  const out: Marker[] = [];
  t.vout.forEach((o, k) => {
    const m = parseOpReturnJson(o.scriptpubkey);
    if (m && m.p === PROTOCOL && typeof m.tick === "string" && TICK_RE.test(m.tick)) out.push({ m, k, tick: m.tick.toUpperCase() });
  });
  return out;
}

/** The first CRC-20 marker, or null. */
export const firstMarker = (t: Tx): Marker | null => markersOf(t)[0] ?? null;

/** A positive-or-zero integer string as BigInt, or null (a malformed amount must never throw mid-block). */
export function bigOrNull(v: unknown): bigint | null {
  try { return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? BigInt(v) : null; } catch { return null; }
}
