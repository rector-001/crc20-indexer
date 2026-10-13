// End-to-end: build → sign → broadcast → pending overlay → simulate → mine → event stream (regtest, test keys only)
// Run on a regtest node that already holds the reference chain, with `crc20 --chain regtest server --http-port 8641`
// and a Bitcoin Core wallet named bonswallet. Keys are fixed test keys (09…, 0b…); never use them anywhere else.
import { execFileSync } from "node:child_process";
import http from "node:http";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { ECPairFactory } from "ecpair";
bitcoin.initEccLib(ecc); const E = ECPairFactory(ecc), NET = bitcoin.networks.regtest;
const API = "http://127.0.0.1:8641";
const cli = (...a) => execFileSync("/root/bitcoin31/bin/bitcoin-cli", ["-regtest", "-rpcwallet=bonswallet", ...a]).toString().trim();
const get = async (p) => (await fetch(API + p)).json();
const post = async (p, b) => { const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 600) : ""); } };
const keyOf = (b) => E.fromPrivateKey(Buffer.from(b.repeat(32), "hex"), { network: NET });
const xo = (k) => Buffer.from(k.publicKey.subarray(1));
const addrOf = (k) => bitcoin.payments.p2tr({ internalPubkey: xo(k), network: NET }).address;
const A = keyOf("09"), B = keyOf("0b"), aAddr = addrOf(A), bAddr = addrOf(B);

// live stream
const ev = [];
http.get(API + "/v1/events/stream", (res) => { let buf = ""; res.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const e = /event: (\w+)/.exec(blk)?.[1]; const data = /data: (.*)/.exec(blk)?.[1]; if (e) ev.push({ e, data: data ? JSON.parse(data) : null }); } }); });

const mine = (n = 1) => cli("generatetoaddress", String(n), bAddr);
// funding for A
const ftx = cli("sendtoaddress", aAddr, "0.001"); mine();
const fraw = JSON.parse(cli("getrawtransaction", ftx, "1"));
const fv = fraw.vout.find((o) => o.scriptPubKey.address === aAddr);
const funding = [{ txid: ftx, vout: fv.n, value: Math.round(fv.value * 1e8) }];
await sleep(5000);

const bal0 = await get(`/v1/addresses/${aAddr}/balances?mempool=1`);
const conf0 = BigInt(bal0.items.find((x) => x.tick === "BONS").confirmed);
ok(conf0 > 0n, "A holds BONS", bal0);

// errors
let r = await post("/v1/build/transfer", { from: aAddr, tick: "BONS", to: bAddr, amount: "100000000", fee_rate: 2 });
ok(r.status === 400 && r.body.error?.code === "funding_required", "build without funding refused", r);
r = await post("/v1/build/transfer", { from: aAddr, tick: "BONS", to: bAddr, amount: (conf0 + 1n).toString(), fee_rate: 2, funding });
ok(r.status === 400 && r.body.error?.code === "insufficient_tokens", "build over balance refused", r);

// build + simulation
const amt = 12345600000000n > conf0 ? conf0 / 2n : 12345600000000n;
r = await post("/v1/build/transfer", { from: aAddr, tick: "BONS", to: bAddr, amount: amt.toString(), fee_rate: 2, funding });
ok(r.status === 200 && r.body.psbt_base64, "build transfer", r);
ok(r.body.simulation?.valid === true && r.body.simulation.rule === "transfer", "build response carries a valid simulation", r.body.simulation);
ok(r.body.inputs_to_sign?.[0]?.useTweakedSigner === true && r.body.inputs_to_sign[0].useTweakSigner === true, "coin input marked for tweaked (address-key) signing", r.body.inputs_to_sign);
const recvCov = r.body.recipient_covenant;

// sign like a wallet: the coin by script path with the address (tweaked) key; funding by key path
const psbt = bitcoin.Psbt.fromBase64(r.body.psbt_base64, { network: NET });
const tw = A.tweak(bitcoin.crypto.taggedHash("TapTweak", xo(A)));
psbt.signInput(0, tw);
for (let i = 1; i < psbt.inputCount; i++) { psbt.updateInput(i, { tapInternalKey: xo(A) }); psbt.signInput(i, tw); }
psbt.finalizeAllInputs();
const signed = psbt.extractTransaction();
const hex = signed.toHex(), txid = signed.getId();
ok(Math.abs(signed.virtualSize() - r.body.vsize) <= 2, `fee estimate vsize ${r.body.vsize} vs real ${signed.virtualSize()}`);

// simulate the signed tx before broadcast
r = await post("/v1/transactions/simulate", { tx_hex: hex });
ok(r.status === 200 && r.body.valid && !r.body.warnings.length && r.body.created.some((c) => c.covenant === recvCov && c.amount === amt.toString()), "simulate signed transfer", r.body);

cli("sendrawtransaction", hex);
await sleep(6000);

// pending overlay
const balA = await get(`/v1/addresses/${aAddr}/balances?mempool=1`), bA = balA.items.find((x) => x.tick === "BONS");
ok(bA.pending_out === conf0.toString() && bA.available === "0", "sender: whole coin pending out", bA);
const balB = await get(`/v1/addresses/${bAddr}/balances?mempool=1`), bB = balB.items.find((x) => x.tick === "BONS");
ok(bB && BigInt(bB.pending_in) === amt, "receiver: pending in", balB);
const plain = await get(`/v1/addresses/${aAddr}/balances`);
const plain0 = await get(`/v1/addresses/${aAddr}/balances?mempool=0`);
ok(!plain0.mempool && !("pending_out" in (plain0.items?.[0] ?? {})), "mempool=0: confirmed-only response", plain0);
const coinsA = await get(`/v1/addresses/${aAddr}/coins?mempool=1`);
ok(coinsA.items.some((c) => c.pending_spent_by === txid) && coinsA.arriving.some((c) => c.txid === txid && BigInt(c.amount) === conf0 - amt), "coins: spent-by + change arriving", coinsA);
const ptx = await get(`/v1/transactions/${txid}`);
ok(ptx.pending === true && ptx.txid === txid, "pending transaction lookup", ptx);

// second build must not reuse the pending coin
r = await post("/v1/build/transfer", { from: aAddr, tick: "BONS", to: bAddr, amount: "1", fee_rate: 2, funding });
ok(r.status === 400 && r.body.error?.code === "insufficient_tokens", "builder skips coins already being spent", r.body);

// a transaction that would burn a coin: spend B's pending... use A's change? Use a confirmed coin of B if any, else the
// coin A is spending (double-spend candidate) with no marker → coin_lost
const coin = coinsA.items[0].outpoint, [ctxid, cv] = coin.split(":");
const bad = new bitcoin.Psbt({ network: NET });
bad.addInput({ hash: ctxid, index: Number(cv), witnessUtxo: { script: bitcoin.address.toOutputScript(bA.covenant, NET), value: 330 } });
bad.addOutput({ address: aAddr, value: 300 });
r = await post("/v1/transactions/simulate", { psbt_base64: bad.toBase64() });
ok(r.status === 200 && r.body.valid === false && r.body.warnings.some((w) => w.code === "coin_lost"), "simulate: coin without marker → coin_lost", r.body);
r = await post("/v1/transactions/simulate", { tx_hex: "zz" });
ok(r.status === 400, "simulate: bad input refused", r);

ok(ev.some((x) => x.e === "hello"), "stream: hello");
ok(ev.some((x) => x.e === "pending" && x.data.txs.some((t) => t.txid === txid)), "stream: pending tx", ev.map((x) => x.e));

// confirm
mine(); await sleep(7000);
const balA2 = await get(`/v1/addresses/${aAddr}/balances?mempool=1`), bA2 = balA2.items.find((x) => x.tick === "BONS");
ok(BigInt(bA2.confirmed) === conf0 - amt && bA2.pending_out === "0", "after block: sender confirmed", bA2);
const balB2 = await get(`/v1/addresses/${bAddr}/balances?mempool=1`), bB2 = balB2.items.find((x) => x.tick === "BONS");
ok(BigInt(bB2.confirmed) >= amt && bB2.pending_in === "0", "after block: receiver confirmed", bB2);
ok(ev.some((x) => x.e === "event" && x.data.txid === txid), "stream: confirmed event", ev.filter((x) => x.e === "event").slice(-3));
ok(ev.some((x) => x.e === "block"), "stream: block");
ok(ev.some((x) => x.e === "pending" && !x.data.txs.length), "stream: pending cleared");

// merge: send B a second coin, then B merges its coins
const fund2 = async (k, addr) => { const t = cli("sendtoaddress", addr, "0.001"); mine(); const j = JSON.parse(cli("getrawtransaction", t, "1")); const o = j.vout.find((v) => v.scriptPubKey.address === addr); return [{ txid: t, vout: o.n, value: Math.round(o.value * 1e8) }]; };
const signSend = (b64, k) => { const p = bitcoin.Psbt.fromBase64(b64, { network: NET }), t = k.tweak(bitcoin.crypto.taggedHash("TapTweak", xo(k)));
  for (let i = 0; i < p.inputCount; i++) { if (!p.data.inputs[i].tapLeafScript) p.updateInput(i, { tapInternalKey: xo(k) }); p.signInput(i, t); }
  p.finalizeAllInputs(); const tx = p.extractTransaction(); cli("sendrawtransaction", tx.toHex()); return tx.getId(); };
r = await post("/v1/build/transfer", { from: aAddr, tick: "BONS", to: bAddr, amount: "100000000", fee_rate: 2, funding: await fund2(A, aAddr) });
ok(r.status === 200 && r.body.simulation.valid, "second transfer built", r.body);
signSend(r.body.psbt_base64, A); mine(); await sleep(6000);
const fB = await fund2(B, bAddr); await sleep(5000);
const coinsB = await get(`/v1/addresses/${bAddr}/coins?tick=BONS`);
r = await post("/v1/build/merge", { from: bAddr, tick: "BONS", fee_rate: 2, funding: fB });
ok(r.status === 200 && r.body.coins.length === coinsB.items.length && r.body.simulation.valid && r.body.simulation.rule === "merge", `merge of ${coinsB.items.length} coins built + simulated`, r.body);
const mtx = signSend(r.body.psbt_base64, B); mine(); await sleep(6000);
const coinsB2 = await get(`/v1/addresses/${bAddr}/coins?tick=BONS`);
ok(coinsB2.items.length === 1 && coinsB2.items[0].outpoint.startsWith(mtx) && coinsB2.items[0].amount === r.body.merged_atoms, "after merge: one coin with the sum", coinsB2);

// reorg: drop the tip, the stream says so; then restore
const tipHash = cli("getbestblockhash"); const before = ev.length;
cli("invalidateblock", tipHash); await sleep(6000);
ok(ev.slice(before).some((x) => x.e === "reorg"), "stream: reorg on invalidated tip", ev.slice(before).map((x) => x.e));
const coinsB3 = await get(`/v1/addresses/${bAddr}/coins?tick=BONS&mempool=1`);
ok(coinsB3.items.length === coinsB.items.length, "after reorg: pre-merge coins back", coinsB3);
cli("reconsiderblock", tipHash); await sleep(6000);
const coinsB4 = await get(`/v1/addresses/${bAddr}/coins?tick=BONS`);
ok(coinsB4.items.length === 1, "after reconsider: merged coin again", coinsB4);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
