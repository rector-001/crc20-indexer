// Covenants — where a wallet's coins of a token live. Ported unchanged from crc20-stack src/covenant.mjs, src/burn.mjs and
// the contract part of src/launchpad.mjs.
//
//   leaf (version 0xc0):  <32-byte CMR> OP_DROP <32-byte owner x-only key> OP_CHECKSIG
//   internal key:         BIP-341 NUMS point (no key path)
//   one covenant address per (owner, token contract)
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { secp256k1 } from "@noble/curves/secp256k1";

bitcoin.initEccLib(ecc);
const { payments, script: bscript, opcodes } = bitcoin;

export const NUMS_HEX = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
export const BONS_CMR = "9bc1262bec613f73c51c455b767216c0d68cfcb8bd097cd817050a30d240ac5b";
/** Provably unspendable P2TR (NUMS key, no script path). Written in its mainnet form; the key is the same on every network. */
export const BURN_ADDRESS_MAINNET = "bc1prykz5vxt6lgr2tu56np35slhvlc77s7hlajr3qucsrkqwhvp48mq5grvgr";
export const LAUNCH_SUPPLY = 1_000_000_000n;
const NUMS = Buffer.from(NUMS_HEX, "hex");

const toXOnly = (k: Buffer): Buffer => (k.length === 33 ? k.subarray(1, 33) : k);

export interface Covenant { address: string; scriptHex: string; leafScriptHex: string; cmrHex: string; ownerXOnlyPublicKeyHex: string }

export function covenantLeaf(ownerXonlyHex: string, cmrHex: string = BONS_CMR): Buffer {
  const owner = toXOnly(Buffer.from(ownerXonlyHex, "hex"));
  if (owner.equals(NUMS)) throw new Error("owner key must differ from NUMS");
  const cmr = Buffer.from(cmrHex, "hex");
  if (cmr.length !== 32) throw new Error("contract commitment must be 32 bytes");
  return Buffer.from(bscript.compile([cmr, opcodes.OP_DROP!, owner, opcodes.OP_CHECKSIG!]));
}

export function deriveCovenant(ownerXonlyHex: string, cmrHex: string, network: bitcoin.Network): Covenant {
  const leaf = covenantLeaf(ownerXonlyHex, cmrHex);
  const p = payments.p2tr({ internalPubkey: NUMS, network, scriptTree: { output: leaf } });
  return { address: p.address!, scriptHex: Buffer.from(p.output!).toString("hex"), leafScriptHex: leaf.toString("hex"),
           cmrHex, ownerXOnlyPublicKeyHex: toXOnly(Buffer.from(ownerXonlyHex, "hex")).toString("hex") };
}

/* FAST OUTPUT KEY: only the 32-byte Taproot output key of the covenant (its address without the encoding), for checking
 * many candidate keys against a few covenants. Q = NUMS + H_TapTweak(NUMS || H_TapLeaf(0xc0 || len || leaf))·G, with the
 * leaf's owner key spliced in place; the same value deriveCovenant encodes. One fixed-base multiplication per call. */
const tagged = (t: string) => { const h = createHash("sha256").update(t, "utf8").digest(); return Buffer.concat([h, h]); };
const TAP_LEAF = tagged("TapLeaf"), TAP_TWEAK = tagged("TapTweak");
const NUMS_POINT = secp256k1.ProjectivePoint.fromHex("02" + NUMS_HEX), NUMS_EVEN = Buffer.from("02" + NUMS_HEX, "hex");
/* The point addition runs in libsecp256k1 (Bitcoin Core's library, the optional `secp256k1` package, prebuilt for the
 * common platforms) when it loads — about 7x faster — and in pure JavaScript otherwise. Both give the same key; the
 * test suite checks that. */
type Native = { publicKeyTweakAdd(pub: Uint8Array, tweak: Uint8Array, compressed?: boolean): Uint8Array };
let native: Native | null = null;
try { native = createRequire(import.meta.url)("secp256k1") as Native; native.publicKeyTweakAdd(NUMS_EVEN, Buffer.alloc(32, 1), true); }
catch { native = null; }
export const curveBackend = (): "libsecp256k1" | "javascript" => (native ? "libsecp256k1" : "javascript");
const tweakOf = (ownerXonly: Buffer, cmr: Buffer): Buffer => {
  // leaf = 0x20 <cmr> 0x75 0x20 <owner> 0xac  (68 bytes)
  const leaf = Buffer.concat([TAP_LEAF, Buffer.from([0xc0, 68, 0x20]), cmr, Buffer.from([0x75, 0x20]), ownerXonly, Buffer.from([0xac])]);
  const leafHash = createHash("sha256").update(leaf).digest();
  return createHash("sha256").update(Buffer.concat([TAP_TWEAK, NUMS, leafHash])).digest();
};
export function covenantOutputKey(ownerXonly: Buffer, cmr: Buffer, useNative = true): string {
  const t = tweakOf(ownerXonly, cmr);
  if (native && useNative) return Buffer.from(native.publicKeyTweakAdd(NUMS_EVEN, t, true)).subarray(1).toString("hex");
  return NUMS_POINT.add(secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + t.toString("hex")))).toAffine().x.toString(16).padStart(64, "0");
}

/** The control block that spends `leaf` of a single-leaf covenant (what a wallet puts in tapLeafScript). */
export function controlBlockOf(ownerXonlyHex: string, cmrHex: string, network: bitcoin.Network): string {
  const leaf = covenantLeaf(ownerXonlyHex, cmrHex);
  const p = payments.p2tr({ internalPubkey: NUMS, network, scriptTree: { output: leaf }, redeem: { output: leaf, redeemVersion: 0xc0 } });
  const w = p.witness!;
  return Buffer.from(w[w.length - 1]!).toString("hex");
}

/** crc.garden's rule: a P2TR address's owner key is its own output key. Throws for any non-Taproot address. */
export function ownerKeyFromAddress(address: string, network: bitcoin.Network): string {
  let spk: Buffer;
  try { spk = Buffer.from(bitcoin.address.toOutputScript(address, network)); }
  catch { throw new Error(`Not a valid address for this network: ${address}`); }
  if (!(spk.length === 34 && spk[0] === opcodes.OP_1 && spk[1] === 0x20))
    throw new Error("Only Taproot addresses can receive CRC-20 — the covenant cannot be derived from a key hash.");
  const owner = spk.subarray(2);
  if (owner.equals(NUMS)) throw new Error("owner key must differ from NUMS");
  return owner.toString("hex");
}

/** The covenant a wallet address owns for a contract (Taproot only), or null. */
export function covenantOfWallet(address: string | null | undefined, cmrHex: string, network: bitcoin.Network): string | null {
  if (!address) return null;
  try { return deriveCovenant(ownerKeyFromAddress(address, network), cmrHex, network).address; } catch { return null; }
}

/** The contract commitment a revealed leaf carries (its first push), or null. */
export function leafCmr(leafScriptHex: string): string | null {
  try {
    const d = bscript.decompile(Buffer.from(leafScriptHex, "hex"));
    const first = d?.[0];
    return Buffer.isBuffer(first) && first.length === 32 ? first.toString("hex") : null;
  } catch { return null; }
}

/** The owner key pushed inside a revealed leaf (second to last item), or null. */
export function ownerFromLeaf(leafScriptHex: string): string | null {
  try {
    const d = bscript.decompile(Buffer.from(leafScriptHex, "hex"));
    const k = d?.[d.length - 2];
    return Buffer.isBuffer(k) && k.length === 32 ? k.toString("hex") : null;
  } catch { return null; }
}

/** A covenant spend: leaf version 0xc0, control block commits NUMS, and the pair rebuilds an address. */
export function validateCovenantSpend(leafScriptHex: string, controlBlockHex: string, network: bitcoin.Network): { ok: boolean; address?: string; reason?: string } {
  try {
    const cb = Buffer.from(controlBlockHex, "hex");
    if ((cb.length - 1) % 32 !== 0) return { ok: false, reason: "bad control block length" };
    if (((cb[0] ?? 0) & 0xfe) !== 0xc0) return { ok: false, reason: "bad leaf version" };
    if (!cb.subarray(1, 33).equals(NUMS)) return { ok: false, reason: "control block not committing NUMS" };
    const p = payments.p2tr({ network, witness: [Buffer.from(leafScriptHex, "hex"), cb] });
    return { ok: true, address: p.address };
  } catch (e) { return { ok: false, reason: (e as Error).message }; }
}

/** [leaf, control block] of a witness when it is a valid covenant spend, else null. */
export function covenantWitness(witness: string[] | undefined, network: bitcoin.Network): { leaf: string; cb: string } | null {
  const w = witness ?? [];
  if (w.length < 2) return null;
  const leaf = w[w.length - 2]!, cb = w[w.length - 1]!;
  return validateCovenantSpend(leaf, cb, network).ok ? { leaf, cb } : null;
}

/** A launchpad token's own contract: sha256 of a versioned descriptor including the deploy txid. */
export function tokenContract(tick: string, deployTxid: string): string {
  return createHash("sha256").update(`crc-20:${tick.toUpperCase()}:v1:bonding:max=${LAUNCH_SUPPLY}:no-timelock:${deployTxid}`, "utf8").digest("hex");
}

/* BURN SINKS: the burn address, its covenant, and covenants of covenants (4 levels). Every owner key in the chain is a
 * NUMS-built output key with no known private key, so all of them are unspendable. */
const BURN_NEST_DEPTH = 4;
export function burnSinks(network: bitcoin.Network): { burnAddress: string; burnCovenant: string; sinks: string[] } {
  const { data, version } = bitcoin.address.fromBech32(BURN_ADDRESS_MAINNET);
  const burnAddress = bitcoin.address.toBech32(Buffer.from(data), version, network.bech32);
  const chain: string[] = [];
  let key = Buffer.from(data).toString("hex");
  for (let i = 0; i < BURN_NEST_DEPTH; i++) {
    const a = deriveCovenant(key, BONS_CMR, network).address;
    chain.push(a);
    key = Buffer.from(bitcoin.address.fromBech32(a).data).toString("hex");
  }
  return { burnAddress, burnCovenant: chain[0]!, sinks: [burnAddress, ...chain] };
}
