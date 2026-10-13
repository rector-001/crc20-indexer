// Unit tests for the protocol code that needs no Bitcoin node. Vectors marked "mainnet" are real: the deploy contract
// commitments and covenant addresses below are on chain, with owners proven by their own transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import {
  BONS_CMR, burnSinks, controlBlockOf, covenantOutputKey, covenantWitness, curveBackend, deriveCovenant, leafCmr,
  ownerFromLeaf, ownerKeyFromAddress, tokenContract, validateCovenantSpend,
} from "../dist/protocol/covenant.js";
import { bigOrNull, markersOf, parseOpReturnJson } from "../dist/protocol/message.js";
import { LAUNCH_ATOMS, ONE, bonsCurve, curveParams, launchCost, quoteBonsMint, quoteLaunch, spotPriceUsdMicros } from "../dist/protocol/curve.js";
import { NETWORKS, isActive } from "../dist/protocol/constants/index.js";

const main = bitcoin.networks.bitcoin;
const outKeyOf = (address) => Buffer.from(bitcoin.address.fromBech32(address).data).toString("hex");

/* ── covenants ──────────────────────────────────────────────────────────────────────────────────────────────────── */

test("mainnet: launchpad token contract = sha256 of its deploy commitment", () => {
  assert.equal(tokenContract("BCAT", "836566dce941dcb320b53238b923295f8a7e2e1ee28359d8b090906d7727bb26"),
    "f7a9db2e388c4037373bb897fd7abe071dcc0e67b91e41a810c4379f3e751b80");
  assert.equal(tokenContract("woof", "b8a2dd2e9c7239b90ad14465e2bb95d4a04eccf93de7f9f80b83b2acf7743d3e"),
    "faa8aa0da210716e7c9b77807a4f255f0eb6da67919a3e4e07a88ba9639c3fdb", "the tick is upper-cased");
});

const OWNERS = [
  { tick: "BONS", cmr: BONS_CMR, wallet: "bc1pq3qht4k45ccx89paqpd3axfwf4cmpyyxgwp79n6lxl8qv3hx8wuslyufll",
    covenant: "bc1p07dvnsjqtmkks6dm8spwkydw3u42e5nht6qcpscgfgfhtq9eny3qtqs0rt" },
  { tick: "BCAT", cmr: "f7a9db2e388c4037373bb897fd7abe071dcc0e67b91e41a810c4379f3e751b80", wallet: "bc1p65wjudtst72fce9q9la89xdkfjg42lrjqp48pn43yvg3xgu3l37stl4k02",
    covenant: "bc1p0ek632jhl7lmdx8jfp3q8xpajvmyhug87v2laga73jfca2gxufrs67vvm4" },
  { tick: "WOOF", cmr: "faa8aa0da210716e7c9b77807a4f255f0eb6da67919a3e4e07a88ba9639c3fdb", wallet: "bc1pnnmec2a6h6ree8fl89pswkjq5eacw5gt43zdpeeyfz6a699n2pjsvu0e9u",
    covenant: "bc1p62r2aslg6jz2ae0pj9fs4q20fxycfd2mmxgpf23vykrqcgqvh7pq2g6aa5" },
];

test("mainnet: a Taproot wallet's covenant for BONS and for launchpad tokens", () => {
  for (const o of OWNERS) {
    const key = ownerKeyFromAddress(o.wallet, main);
    assert.equal(deriveCovenant(key, o.cmr, main).address, o.covenant, o.tick);
    assert.equal(covenantOutputKey(Buffer.from(key, "hex"), Buffer.from(o.cmr, "hex")), outKeyOf(o.covenant), `${o.tick} fast path`);
  }
});

test("mainnet: a P2WPKH wallet's covenant comes from its public key", () => {
  assert.equal(deriveCovenant("8ff624191d3ab58cc607b2303c080f5b374d2e1e5049b91cf729fc39b3378235", BONS_CMR, main).address,
    "bc1pgmgk4mlqpvr60hl2sdj74rrlt9nrdsngzvagjlp4qlgjkqnddgfs8h6mkj");
});

test("mainnet: the burn chain (burn address, its covenant, and covenants of covenants)", () => {
  const b = burnSinks(main);
  assert.equal(b.burnAddress, "bc1prykz5vxt6lgr2tu56np35slhvlc77s7hlajr3qucsrkqwhvp48mq5grvgr");
  assert.deepEqual(b.sinks, [
    "bc1prykz5vxt6lgr2tu56np35slhvlc77s7hlajr3qucsrkqwhvp48mq5grvgr",
    "bc1pnnhy6cqnv62ps9s0wpkv6y5umjulz05x53tq678y2m56xwqadyrsu2gdqc",
    "bc1pgkfnnfc2zdyva8r60jakxqqplc65tutl2trkvhvqf24jhktxa5ss44dqmq",
    "bc1ppmy5wwk507v403spvx0x7trdmqme3sf3eqv7fc7fdahf05703udszqlz69",
    "bc1p8l2k8mfa7n0x686qlh0d5vy4p0cad94ycfa784t204xfv8etjcdsggxr4a",
  ]);
  assert.equal(b.burnCovenant, b.sinks[1]);
});

test(`fast output key = deriveCovenant, native and JavaScript backends (this machine: ${curveBackend()})`, () => {
  for (const cmr of [BONS_CMR, OWNERS[1].cmr]) for (let i = 0; i < 300; i++) {
    const k = randomBytes(32), c = Buffer.from(cmr, "hex");
    const slow = outKeyOf(deriveCovenant(k.toString("hex"), cmr, main).address);
    assert.equal(covenantOutputKey(k, c), slow);
    assert.equal(covenantOutputKey(k, c, false), slow);
  }
});

test("a covenant spend: control block, leaf, owner and contract round-trip", () => {
  const { wallet, cmr, covenant } = OWNERS[1];
  const key = ownerKeyFromAddress(wallet, main), cv = deriveCovenant(key, cmr, main), cb = controlBlockOf(key, cmr, main);
  assert.deepEqual(validateCovenantSpend(cv.leafScriptHex, cb, main), { ok: true, address: covenant });
  assert.equal(ownerFromLeaf(cv.leafScriptHex), key);
  assert.equal(leafCmr(cv.leafScriptHex), cmr);
  assert.deepEqual(covenantWitness(["00".repeat(64), cv.leafScriptHex, cb], main), { leaf: cv.leafScriptHex, cb });
  assert.equal(covenantWitness(["00".repeat(64)], main), null, "a key-path spend is not a covenant spend");
  const other = controlBlockOf(ownerKeyFromAddress(OWNERS[0].wallet, main), cmr, main);
  assert.equal(validateCovenantSpend(cv.leafScriptHex, other, main).ok, false, "a control block for another leaf fails");
});

/* ── markers ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const opReturn = (...pushes) => bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, ...pushes.map((p) => Buffer.from(p))]).toString("hex");
const txWith = (...scripts) => ({ txid: "00".repeat(32), vin: [], vout: scripts.map((s) => ({ value: 0, scriptpubkey: s, scriptpubkey_type: "op_return" })) });

test("marker: the LAST push of an OP_RETURN, JSON object only", () => {
  assert.deepEqual(parseOpReturnJson(opReturn('{"p":"crc-20","op":"mint","tick":"BONS"}')), { p: "crc-20", op: "mint", tick: "BONS" });
  assert.deepEqual(parseOpReturnJson(opReturn("ord", '{"p":"crc-20","op":"transfer","tick":"BONS","amt":"1"}'))?.op, "transfer");
  assert.equal(parseOpReturnJson(opReturn('{"p":"crc-20"}', "x")), null, "a later non-JSON push wins");
  assert.equal(parseOpReturnJson(opReturn("[1,2]")), null);
  assert.equal(parseOpReturnJson(opReturn("{not json")), null);
  assert.equal(parseOpReturnJson("51" + "20" + "00".repeat(32)), null, "not an OP_RETURN");
});

test("marker: protocol and tick are checked; tick is upper-cased", () => {
  const ok = opReturn('{"p":"crc-20","op":"transfer","tick":"bcat","amt":"5"}');
  assert.deepEqual(markersOf(txWith(ok)).map((m) => [m.tick, m.k]), [["BCAT", 0]]);
  assert.equal(markersOf(txWith(opReturn('{"p":"brc-20","op":"mint","tick":"BONS"}'))).length, 0);
  assert.equal(markersOf(txWith(opReturn('{"p":"crc-20","op":"mint","tick":"X"}'))).length, 0, "tick under 2 characters");
  assert.equal(markersOf(txWith(opReturn('{"p":"crc-20","op":"mint","tick":"TOOLONGXX"}'))).length, 0, "tick over 8 characters");
  assert.equal(markersOf(txWith(opReturn('{"p":"crc-20","op":"mint","tick":"B-NS"}'))).length, 0);
});

test("amounts: malformed values are null, never a throw", () => {
  assert.equal(bigOrNull("100000000"), 100000000n);
  assert.equal(bigOrNull("1.5"), null);
  assert.equal(bigOrNull({}), null);
  assert.equal(bigOrNull(undefined), null);
});

/* ── the BONS curve ─────────────────────────────────────────────────────────────────────────────────────────────── */

const bons = bonsCurve(21_000_000n);

test("BONS curve: an opening slope over the first 10%, then a linear slope from p0 to 4·p0", () => {
  const c = curveParams(bons);
  assert.equal(c.openingAtoms, 2_100_000n * ONE);
  assert.equal(c.publicAtoms, 18_900_000n * ONE);
  assert.equal(c.openingTotalMicros, 200_000_000n, "$200 across the opening slope");
  assert.equal(c.p0, 740n, "$0.00074 at the start of the linear slope");
  assert.equal(c.p1, 2960n, "$0.00296 at the end: 4 × p0");
  assert.equal(spotPriceUsdMicros(0n, bons), c.p0);
  assert.equal(spotPriceUsdMicros(c.publicAtoms, bons), c.p1);
  assert.equal(spotPriceUsdMicros(c.publicAtoms / 2n, bons), (c.p0 + c.p1) / 2n);
});

test("BONS mint: priced at spot, clamped to what is left", () => {
  // 100,000 sats at $100,000/BTC = $100 at the linear slope's start price ($0.00074) ≈ 135,135 BONS
  const q = quoteBonsMint({ sats: 100_000n, btcUsd: "100000", publicMinted: 0n, openingMinted: 0n, onOpening: false, curve: bons });
  assert.equal(q.slope, "public");
  assert.equal(q.allocatedAtoms, (100_000_000n * ONE) / 740n);
  const c = curveParams(bons);
  const end = quoteBonsMint({ sats: 10n ** 9n, btcUsd: "100000", publicMinted: c.publicAtoms - ONE, openingMinted: 0n, onOpening: false, curve: bons });
  assert.deepEqual([end.status, end.allocatedAtoms], ["clamped", ONE]);
  const done = quoteBonsMint({ sats: 1000n, btcUsd: "100000", publicMinted: c.publicAtoms, openingMinted: 0n, onOpening: false, curve: bons });
  assert.equal(done.allocatedAtoms, 0n);
});

/* ── the launchpad curve ────────────────────────────────────────────────────────────────────────────────────────── */

const TARGET = 2_500_000n;   // sats

test("launch curve: the whole supply costs exactly the target", () => {
  assert.equal(launchCost(TARGET, 0n, LAUNCH_ATOMS), TARGET * 1_000_000n);
});

test("launch curve: the price ends at 4× where it starts", () => {
  const d = 1_000_000n * ONE;
  const first = launchCost(TARGET, 0n, d), last = launchCost(TARGET, LAUNCH_ATOMS - d, d);
  const ratio = Number(last) / Number(first);
  assert.ok(Math.abs(ratio - 4) < 0.01, `ratio ${ratio}`);
});

test("launch curve: splitting a buy never costs less", () => {
  for (let i = 0; i < 200; i++) {
    const x = BigInt(Math.floor(Math.random() * 9e8)) * ONE, a = BigInt(1 + Math.floor(Math.random() * 1e7)) * 1000n, b = BigInt(1 + Math.floor(Math.random() * 1e7)) * 1000n;
    assert.ok(launchCost(TARGET, x, a) + launchCost(TARGET, x + a, b) >= launchCost(TARGET, x, a + b));
  }
});

test("launch quote: the most a budget buys, and not one atom more", () => {
  for (const budget of [1_000_000n, 123_456_789n, 2_000_000_000_000n]) for (const x of [0n, 500_000_000n * ONE]) {
    const q = quoteLaunch(TARGET, x, budget);
    assert.ok(q.costMicros <= budget);
    if (q.status === "allocated") assert.ok(launchCost(TARGET, x, q.atoms + 1n) > budget);
  }
  assert.equal(quoteLaunch(TARGET, LAUNCH_ATOMS, 10n ** 12n).status, "sold_out");
  assert.equal(quoteLaunch(TARGET, 0n, 10n ** 18n).status, "clamped");
});

/* ── activations ────────────────────────────────────────────────────────────────────────────────────────────────── */

test("activations: a height, or pending (never active)", () => {
  assert.equal(isActive(NETWORKS.bitcoin.activations.merge, 969975), false);
  assert.equal(isActive(NETWORKS.bitcoin.activations.merge, 969976), true);
  assert.equal(isActive("pending", 10 ** 9), false);
  assert.equal(NETWORKS.bitcoin.deployBlock, 968367);
});

test("BONS's contract commitment is fixed forever", () => {
  assert.equal(BONS_CMR, "9bc1262bec613f73c51c455b767216c0d68cfcb8bd097cd817050a30d240ac5b");
});
