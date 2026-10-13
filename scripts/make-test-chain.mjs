#!/usr/bin/env node
// Record a regtest chain as the consensus test vector (test/vectors/regtest-chain.json.gz).
//
//   node scripts/make-test-chain.mjs --rpc http://user:pass@127.0.0.1:18443 --addresses addr.json --oracle-usd 85000
//
// The chain comes from the reference test suites, which also exercise rules this indexer does not ship. Before it is
// recorded, every transaction those rules would read is made neutral:
//   - a CRC-20 marker whose op is not deploy, mint or transfer becomes {"p":"crc-20","op":"unknown","tick":…};
//   - a script-path witness that is not a CRC-20 coin spend is replaced by a single 64-byte placeholder.
// A rewritten marker changes its transaction's id, so every later input spending it is rewritten too (in order).
// The script then PROVES the recording is equivalent: it indexes the recorded chain (through the mock node) and the
// original chain (through the real node), maps the new transaction ids back, and requires every exported ledger row to
// be identical. Only then is the vector written, with the recorded chain's ledger hash as the expected value.
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import { BitcoinRpc } from "../dist/index/fetcher.js";
import { updateIndex } from "../dist/index/updater.js";
import { openLedger } from "../dist/store/ledger.js";
import { exportLedger } from "../dist/store/export.js";
import { makeCtx } from "../dist/protocol/context.js";
import { NETWORKS, withAddresses } from "../dist/protocol/constants/index.js";
import { startMockNode } from "../test/support/mock-node.mjs";

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const rpcUrl = new URL(arg("rpc") ?? "http://127.0.0.1:18443");
// only the protocol's own address roles (the ones NetworkConstants defines) go into the vector
const ROLES = ["treasury", "curveOpeningPayer", "protocolFee", "launchEscrow", "launchPreburnCovenant"];
const addresses = Object.fromEntries(Object.entries(JSON.parse(readFileSync(arg("addresses"), "utf8"))).filter(([k]) => ROLES.includes(k)));
const oracleUsd = arg("oracle-usd") ?? "85000";
const out = arg("out") ?? "test/vectors/regtest-chain.json.gz";
const PUBLIC_OPS = new Set(["deploy", "mint", "transfer"]);

const rpc = new BitcoinRpc({ url: `${rpcUrl.protocol}//${rpcUrl.host}`, username: decodeURIComponent(rpcUrl.username) || undefined, password: decodeURIComponent(rpcUrl.password) || undefined });
const tip = await rpc.getBlockCount();
const original = [];
for (let h = 0; h <= tip; h++) original.push(await rpc.call("getblock", [await rpc.getBlockHash(h), 0]));

/* ── sanitize ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
const isCovenantLeaf = (l) => l.length === 68 && l[0] === 0x20 && l[33] === 0x75 && l[34] === 0x20 && l[67] === 0xac;
const renamed = new Map(); let markers = 0, witnesses = 0;
const recorded = original.map((hex) => {
  const b = bitcoin.Block.fromHex(hex);
  for (const t of b.transactions) {
    const before = t.getId();
    for (const i of t.ins) {
      const prev = Buffer.from(i.hash).reverse().toString("hex");
      if (renamed.has(prev)) i.hash = Buffer.from(renamed.get(prev), "hex").reverse();
      const w = i.witness ?? [];
      if (w.length >= 2) {
        const cb = w[w.length - 1], leaf = w[w.length - 2];
        if (cb.length >= 33 && (cb[0] & 0xfe) === 0xc0 && !isCovenantLeaf(leaf)) { i.witness = [Buffer.alloc(64)]; witnesses++; }
      }
    }
    for (const o of t.outs) {
      if (o.script[0] !== 0x6a) continue;
      const ch = bitcoin.script.decompile(o.script), d = ch?.[ch.length - 1];
      let m = null; try { m = Buffer.isBuffer(d) ? JSON.parse(d.toString("utf8")) : null; } catch { /* not JSON */ }
      if (m?.p === "crc-20" && !PUBLIC_OPS.has(m.op)) {
        o.script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(JSON.stringify({ p: "crc-20", op: "unknown", tick: m.tick }), "utf8")]);
        markers++;
      }
    }
    if (t.getId() !== before) renamed.set(before, t.getId());
  }
  return b.toHex();
});
// every marker left in the recording must be a public op (or the neutral "unknown")
for (const hex of recorded) for (const t of bitcoin.Block.fromHex(hex).transactions) for (const o of t.outs) {
  if (o.script[0] !== 0x6a) continue;
  const ch = bitcoin.script.decompile(o.script), d = ch?.[ch.length - 1];
  let m = null; try { m = Buffer.isBuffer(d) ? JSON.parse(d.toString("utf8")) : null; } catch { /* not JSON */ }
  if (m?.p === "crc-20" && !PUBLIC_OPS.has(m.op) && m.op !== "unknown") throw new Error(`a non-public marker survived: ${t.getId()}`);
}
console.error(`sanitized: ${markers} markers, ${witnesses} witnesses, ${renamed.size} transaction ids rewritten`);

/* ── prove equivalence ────────────────────────────────────────────────────────────────────────────────────────────── */
const net = withAddresses(NETWORKS.regtest, addresses), dir = mkdtempSync(join(tmpdir(), "crc20-vec-"));
async function ledgerOf(url, file, auth) {
  const db = openLedger(join(dir, file));
  await updateIndex(makeCtx(db, net), new BitcoinRpc({ url, ...auth }), { pinned: new Map(), fixedUsd: oracleUsd }, { lookup: true, log: () => {} });
  return exportLedger(db);
}
const mock = await startMockNode(recorded);
const rec = await ledgerOf(mock.url, "recorded.sqlite", {});
await mock.close();
const orig = await ledgerOf(`${rpcUrl.protocol}//${rpcUrl.host}`, "original.sqlite", { username: decodeURIComponent(rpcUrl.username), password: decodeURIComponent(rpcUrl.password) });
const back = new Map([...renamed].map(([o, n]) => [n, o]));
const unmap = (line) => line.replace(/[0-9a-f]{64}/g, (id) => back.get(id) ?? id);
// rows are sorted by txid/outpoint, so a renamed id moves its row: compare as sets of rows
const a = rec.lines.map(unmap).sort(), b = [...orig.lines].sort();
const diff = a.filter((l, i) => l !== b[i]);
if (a.length !== b.length || diff.length) { console.error(`NOT EQUIVALENT: ${a.length} vs ${b.length} rows; first differences:\n${diff.slice(0, 5).join("\n")}`); process.exit(1); }
console.error(`equivalent: all ${b.length} ledger rows identical (original chain sha256 ${orig.sha256})`);

writeFileSync(out, gzipSync(JSON.stringify({
  about: "Regtest chain from the reference test suites, sanitized (see scripts/make-test-chain.mjs). Replay it through test/support/mock-node.mjs.",
  network: "regtest", addresses, oracleUsd, blocks: recorded,
  expect: { cursor: rec.cursor, rows: rec.rows, sha256: rec.sha256 },
}), { level: 9 }));
console.log(JSON.stringify({ out, blocks: recorded.length, rows: rec.rows, sha256: rec.sha256 }));
