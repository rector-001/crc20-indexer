// Unsigned PSBT builders (optional helpers — anyone can build the same transactions from /v1 coin data). The wallet
// signs with its own key (UniSat / Xverse / OKX signPsbt); this node never sees a key or a signature.
//   POST /v1/build/transfer  { from, public_key?, tick, to, amount, fee_rate, funding: [{txid, vout, value}], change? }
//   POST /v1/build/merge     { from, public_key?, tick, fee_rate, funding, outpoints? }
// Layout (the reference builders'): out 0 = marker; out 1 = receiver coin (330); out 2 = change coin (330, when part of
// the coin stays); then BTC change. Input 0 = the coin(s), by script path; then the wallet's BTC inputs.
import * as bitcoin from "bitcoinjs-lib";
import { all, one, getCursor } from "../store/ledger.js";
import { BONS_CMR, NUMS_HEX, controlBlockOf, deriveCovenant, ownerKeyFromAddress } from "../protocol/covenant.js";
import { TICK, type Ctx } from "../protocol/context.js";
import { isActive } from "../protocol/constants/index.js";
import { ApiError, resolve } from "./query.js";

interface Funding { txid: string; vout: number; value: number }
interface BuildBody { from?: string; public_key?: string; tick?: string; to?: string; amount?: string; fee_rate?: number; funding?: Funding[]; change?: string; outpoints?: string[] }

const DUST = 330;
/** vbytes, as the reference measured them: a coin input ~86 (script path: 64-byte sig + 68-byte leaf + 33-byte control
 *  block), a Taproot key-path input 57.5, a P2WPKH input 68; a Taproot output 43, a P2WPKH output 31; 10.5 overhead. */
const vbIn = (spk: Buffer) => (spk.length === 34 && spk[0] === 0x51 ? 57.5 : 68);
const vbOut = (spk: Buffer) => (spk[0] === 0x6a ? 9 + spk.length : spk.length === 34 ? 43 : spk.length === 22 ? 31 : 34 + spk.length);

function contractOf(c: Ctx, tick: string): string {
  if (tick === TICK) return BONS_CMR;
  const d = one<{ cmr: string | null }>(c.db, "SELECT cmr FROM deploy WHERE tick = ?", tick);
  if (!d?.cmr) throw new ApiError(404, "not_found", `No token ${tick} on this chain.`);
  return d.cmr;
}

/** The coin address tokens are sent to: a Taproot wallet's covenant for the token — or, when `to` already IS a covenant
 *  of that token (it holds coins of it), that covenant itself (never a covenant of a covenant). */
function recipientCovenant(c: Ctx, tick: string, to: string, cmr: string): string {
  if (one(c.db, "SELECT 1 FROM seals WHERE owner_address = ? AND tick = ? LIMIT 1", to, tick)) return to;
  try { return deriveCovenant(ownerKeyFromAddress(to, c.btc), cmr, c.btc).address; }
  catch { throw new ApiError(400, "recipient_not_taproot", "The recipient must be a Taproot (bc1p…) address: a CRC-20 covenant is derived from the wallet's own key."); }
}

function common(c: Ctx, b: BuildBody) {
  if (!b.from || !b.tick) throw new ApiError(400, "bad_request", "from and tick are required.");
  const tick = b.tick.toUpperCase(), cmr = contractOf(c, tick);
  const r = resolve(c, b.from, b.public_key);
  if (r.kind !== "wallet" || !r.ownerKey) throw new ApiError(400, "bad_request", "from must be the wallet address (not a covenant).");
  const feeRate = Number(b.fee_rate);
  if (!(feeRate >= 1 && feeRate <= 5000)) throw new ApiError(400, "bad_fee_rate", "fee_rate (sat/vB) between 1 and 5000.");
  if (!Array.isArray(b.funding) || !b.funding.length) throw new ApiError(400, "funding_required", "Pass funding: the wallet's BTC outputs to pay the fee ([{txid, vout, value}]). This node keeps no wallet UTXO list.");
  const fromSpk = Buffer.from(bitcoin.address.toOutputScript(b.from, c.btc));
  const fund = b.funding.map((f) => {
    if (!/^[0-9a-f]{64}$/.test(String(f.txid)) || !Number.isInteger(f.vout) || !(Number(f.value) > 0)) throw new ApiError(400, "bad_funding", "Each funding entry is {txid, vout, value (sats)}.");
    if (one(c.db, "SELECT 1 FROM seals WHERE outpoint = ? AND status = 'active'", `${f.txid}:${f.vout}`)) throw new ApiError(400, "funding_is_a_coin", `${f.txid}:${f.vout} holds tokens; never spend it as BTC.`);
    return f;
  });
  const covenant = deriveCovenant(r.ownerKey, cmr, c.btc);
  const cb = Buffer.from(controlBlockOf(r.ownerKey, cmr, c.btc), "hex");
  const changeSpk = Buffer.from(bitcoin.address.toOutputScript(b.change ?? b.from, c.btc));
  return { tick, cmr, r, feeRate, fund, fromSpk, covenant, cb, changeSpk };
}

function finish(c: Ctx, psbt: bitcoin.Psbt, x: ReturnType<typeof common>, coinInputs: number, outVb: number) {
  const inputVb = coinInputs * 86 + x.fund.length * vbIn(x.fromSpk);
  const totalIn = x.fund.reduce((a, f) => a + Number(f.value), 0) + coinInputs * 330;
  const fixedOut = psbt.txOutputs.reduce((a, o) => a + Number(o.value), 0);
  const vbNoChange = 10.5 + inputVb + outVb, vbChange = vbNoChange + vbOut(x.changeSpk);
  const feeWith = Math.ceil(vbChange * x.feeRate), change = totalIn - fixedOut - feeWith;
  let fee: number, vsize: number;
  if (change >= DUST) { psbt.addOutput({ script: x.changeSpk, value: change }); fee = feeWith; vsize = Math.ceil(vbChange); }
  else { fee = totalIn - fixedOut; vsize = Math.ceil(vbNoChange); if (fee < Math.ceil(vbNoChange * x.feeRate)) throw new ApiError(400, "insufficient_funds", `The funding outputs (${totalIn - coinInputs * 330} sats) do not cover the outputs and a ${x.feeRate} sat/vB fee.`); }
  return {
    psbt_base64: psbt.toBase64(),
    inputs_to_sign: psbt.txInputs.map((_, i) => i < coinInputs
      // a covenant input is signed by script path with the wallet's TWEAKED key — the address key the leaf holds.
      // UniSat reads useTweakedSigner; OKX reads useTweakSigner (without it OKX signs a tapleaf with the untweaked key).
      ? { index: i, address: x.r.address, publicKey: x.r.ownerKey, sighashTypes: [0], useTweakedSigner: true, useTweakSigner: true, disableTweakSigner: false }
      : { index: i, address: x.r.address, ...(x.fromSpk.length === 34 && x.fromSpk[0] === 0x51 ? { useTweakedSigner: true } : {}) }),
    fee_sats: fee, vsize, fee_rate: x.feeRate,
  };
}

function coinInput(psbt: bitcoin.Psbt, outpoint: string, x: ReturnType<typeof common>) {
  const [txid, vout] = outpoint.split(":") as [string, string];
  psbt.addInput({ hash: txid, index: Number(vout), sequence: 0xfffffffd,
    witnessUtxo: { script: Buffer.from(x.covenant.scriptHex, "hex"), value: 330 },
    tapInternalKey: Buffer.from(NUMS_HEX, "hex"),
    tapLeafScript: [{ leafVersion: 0xc0, script: Buffer.from(x.covenant.leafScriptHex, "hex"), controlBlock: x.cb }] });
}
const marker = (tick: string, amt: bigint) =>
  Buffer.from(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({ p: "crc-20", op: "transfer", tick, amt: amt.toString() }), "utf8")]));

export function buildTransfer(c: Ctx, b: BuildBody, pendingSpent: Set<string>) {
  const x = common(c, b);
  if (!b.to) throw new ApiError(400, "bad_request", "to is required.");
  let amt: bigint;
  try { amt = BigInt(String(b.amount)); } catch { throw new ApiError(400, "bad_amount", "amount is an integer string of atoms (1 token = 100000000)."); }
  if (amt <= 0n) throw new ApiError(400, "bad_amount", "amount must be above 0.");
  const coins = all<{ outpoint: string; amount_atoms: string }>(c.db, "SELECT outpoint, amount_atoms FROM seals WHERE owner_address = ? AND tick = ? AND status = 'active'", x.covenant.address, x.tick)
    .filter((k) => !pendingSpent.has(k.outpoint)).sort((p, q) => (BigInt(p.amount_atoms) < BigInt(q.amount_atoms) ? -1 : 1));
  const total = coins.reduce((a, k) => a + BigInt(k.amount_atoms), 0n);
  if (total < amt) throw new ApiError(400, "insufficient_tokens", `This wallet holds ${total} atoms of ${x.tick} (not counting coins already being spent).`);
  const coin = coins.find((k) => BigInt(k.amount_atoms) >= amt);
  if (!coin) throw new ApiError(409, "merge_first", `No single coin holds ${amt} atoms: build a merge first (POST /v1/build/merge), then send.`);
  const recv = recipientCovenant(c, x.tick, b.to, x.cmr);
  const psbt = new bitcoin.Psbt({ network: c.btc });
  coinInput(psbt, coin.outpoint, x);
  for (const f of x.fund) psbt.addInput({ hash: f.txid, index: f.vout, sequence: 0xfffffffd, witnessUtxo: { script: x.fromSpk, value: Number(f.value) } });
  const mk = marker(x.tick, amt), recvSpk = Buffer.from(bitcoin.address.toOutputScript(recv, c.btc));
  psbt.addOutput({ script: mk, value: 0 });
  psbt.addOutput({ script: recvSpk, value: 330 });
  let outVb = vbOut(mk) + vbOut(recvSpk);
  const rest = BigInt(coin.amount_atoms) - amt;
  if (rest > 0n) { const own = Buffer.from(x.covenant.scriptHex, "hex"); psbt.addOutput({ script: own, value: 330 }); outVb += vbOut(own); }
  return { ...finish(c, psbt, x, 1, outVb), coin: coin.outpoint, recipient_covenant: recv, change_coin_atoms: rest.toString() };
}

export function buildMerge(c: Ctx, b: BuildBody, pendingSpent: Set<string>) {
  const x = common(c, b);
  const h = (getCursor(c.db) ?? 0);
  if (!isActive(c.net.activations.merge, h)) throw new ApiError(400, "not_active", "Merge is not active on this network yet.");
  let coins = all<{ outpoint: string; amount_atoms: string }>(c.db, "SELECT outpoint, amount_atoms FROM seals WHERE owner_address = ? AND tick = ? AND status = 'active'", x.covenant.address, x.tick)
    .filter((k) => !pendingSpent.has(k.outpoint));
  if (b.outpoints?.length) { const want = new Set(b.outpoints); coins = coins.filter((k) => want.has(k.outpoint)); }
  if (coins.length < 2) throw new ApiError(400, "nothing_to_merge", "A merge needs at least 2 coins of this token.");
  coins = coins.slice(0, 50);
  const total = coins.reduce((a, k) => a + BigInt(k.amount_atoms), 0n);
  const psbt = new bitcoin.Psbt({ network: c.btc });
  for (const k of coins) coinInput(psbt, k.outpoint, x);
  for (const f of x.fund) psbt.addInput({ hash: f.txid, index: f.vout, sequence: 0xfffffffd, witnessUtxo: { script: x.fromSpk, value: Number(f.value) } });
  const mk = marker(x.tick, total), own = Buffer.from(x.covenant.scriptHex, "hex");
  psbt.addOutput({ script: mk, value: 0 });
  psbt.addOutput({ script: own, value: 330 });
  return { ...finish(c, psbt, x, coins.length, vbOut(mk) + vbOut(own)), coins: coins.map((k) => k.outpoint), merged_atoms: total.toString() };
}
