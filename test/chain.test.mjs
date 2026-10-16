// Consensus test vector: a recorded regtest chain (test/vectors/regtest-chain.json.gz, made by scripts/make-test-chain.mjs)
// replayed through a mock Bitcoin Core. Every node must reach the same ledger hash; reorgs must undo cleanly; owner
// links must come out the same however the blocks are fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BitcoinRpc } from "../dist/index/fetcher.js";
import { updateIndex } from "../dist/index/updater.js";
import { openLedger, all, rewindTo } from "../dist/store/ledger.js";
import { exportLedger } from "../dist/store/export.js";
import { makeCtx } from "../dist/protocol/context.js";
import { NETWORKS, withAddresses } from "../dist/protocol/constants/index.js";
import { startApi } from "../dist/api/server.js";
import { startMockNode } from "./support/mock-node.mjs";

const V = JSON.parse(gunzipSync(readFileSync(new URL("./vectors/regtest-chain.json.gz", import.meta.url))).toString());
// the swap rules are active on regtest from block 0: the expected ledger for this chain with them
V.expect = JSON.parse(readFileSync(new URL("./vectors/swap-rules-expect.json", import.meta.url), "utf8")); delete V.expect.about;
const net = withAddresses(NETWORKS.regtest, V.addresses);
const dir = mkdtempSync(join(tmpdir(), "crc20-test-"));
let n = 0;

async function sync(url, { file, lookup = true, heightLimit, db } = {}) {
  db ??= openLedger(join(dir, file ?? `ledger-${n++}.sqlite`));
  const c = makeCtx(db, net);
  await updateIndex(c, new BitcoinRpc({ url }), { pinned: new Map(), fixedUsd: V.oracleUsd }, { lookup, heightLimit, log: () => {} });
  return { db, c };
}
const owners = (db) => all(db, "SELECT covenant_address, wallet_address, owner_xonly, source FROM covenant_owners ORDER BY covenant_address");

test("replay: raw blocks with prevout lookups (the default) reach the expected ledger hash", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const { db } = await sync(node.url);
    const e = exportLedger(db);
    assert.deepEqual({ cursor: e.cursor, rows: e.rows, sha256: e.sha256 }, V.expect);
  } finally { await node.close(); }
});

test("replay: getblock verbosity 3 reaches the same hash, and names the same owners", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const a = await sync(node.url, { lookup: true }), b = await sync(node.url, { lookup: false });
    assert.equal(exportLedger(b.db).sha256, V.expect.sha256);
    const oa = owners(a.db), ob = owners(b.db);
    assert.ok(oa.length > 100, `owners named: ${oa.length}`);
    assert.deepEqual(ob, oa);
  } finally { await node.close(); }
});

test("resumable: stopping part-way and continuing gives the same ledger", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const { db } = await sync(node.url, { heightLimit: 600 });
    assert.equal(exportLedger(db).cursor, 600);
    await sync(node.url, { db });
    assert.equal(exportLedger(db).sha256, V.expect.sha256);
  } finally { await node.close(); }
});

test("reorg: a shorter chain rolls the ledger back; the longer one restores it", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const tip = node.tipHeight(), back = tip - 40;
    const { db } = await sync(node.url);
    // the node drops 40 blocks (no new block yet): the next sync must roll back to match
    node.setTip(back);
    await sync(node.url, { db });
    const short = await sync(node.url, { heightLimit: back + 1 });
    assert.equal(exportLedger(db).sha256, exportLedger(short.db).sha256, "rolled back = indexed to the shorter tip");
    // and the blocks come back
    node.setTip(tip);
    await sync(node.url, { db });
    assert.equal(exportLedger(db).sha256, V.expect.sha256);
  } finally { await node.close(); }
});

test("rollback to any height = a fresh sync to that height (every kind of event in between)", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const full = await sync(node.url, { file: "full.sqlite" });
    const deploys = all(full.db, "SELECT height FROM deploy ORDER BY height").map((r) => r.height);
    const merges = all(full.db, "SELECT MIN(height) h FROM deltas WHERE op LIKE 'merge:%'")[0].h;
    const burns = all(full.db, "SELECT MIN(height) h FROM deltas WHERE op LIKE 'burn:%'")[0].h;
    const points = [...new Set([...deploys.flatMap((h) => [h, h + 1]), merges, burns, node.tipHeight() - 1].filter((h) => h != null))].sort((a, b) => b - a);
    for (const h of points) {
      rewindTo(full.db, h);                                    // keeps blocks below h
      const fresh = await sync(node.url, { heightLimit: h });
      assert.equal(exportLedger(full.db).sha256, exportLedger(fresh.db).sha256, `rolled back to ${h}`);
    }
  } finally { await node.close(); }
});

test("reorg: a different block at the same height replaces the old one", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const tip = node.tipHeight();
    const { db } = await sync(node.url);
    // a fork that drops the last 3 blocks and mines one empty block in their place (coinbase only)
    const { default: bitcoin } = await import("bitcoinjs-lib").then((m) => ({ default: m }));
    const parent = bitcoin.Block.fromHex(V.blocks[tip - 3]), last = bitcoin.Block.fromHex(V.blocks[tip]);
    const fork = new bitcoin.Block();
    Object.assign(fork, { version: 0x20000000, prevHash: parent.getHash(), merkleRoot: Buffer.alloc(32, 7), timestamp: parent.timestamp + 1, bits: parent.bits, nonce: 1, transactions: [last.transactions[0]] });
    node.replaceFrom(tip - 2, [fork.toHex()]);
    await sync(node.url, { db });
    const blocks = all(db, "SELECT height, hash FROM blocks WHERE height >= ? ORDER BY height", tip - 3);
    assert.deepEqual(blocks.map((b) => b.height), [tip - 3, tip - 2]);
    assert.equal(blocks[1].hash, fork.getId());
    const reference = await sync(node.url, { heightLimit: tip - 2 });   // the ledger up to the fork's parent
    const strip = (rows) => rows.filter((l) => !l.startsWith("blocks\t") && !l.startsWith("meta\t{\"k\":\"cursor\""));
    assert.deepEqual(strip(exportLedger(db).lines.filter((l) => !l.includes(`"height":${tip - 2}`))), strip(exportLedger(reference.db).lines));
  } finally { await node.close(); }
});

test("API: serves what the ledger holds", async () => {
  const node = await startMockNode(V.blocks);
  try {
    const file = join(dir, "api.sqlite");
    await sync(node.url, { file: "api.sqlite" });
    const reader = new DatabaseSync(file, { readOnly: true });
    const server = startApi(makeCtx(reader, net), { port: 0, version: "test", pinned: {}, chainTip: () => node.tipHeight(), dbPath: file, rpc: null, mempool: null });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
    try {
      const s = await get("/v1/status");
      assert.equal(s.body.indexed_height, V.expect.cursor - 1);
      assert.equal(s.body.synced, true);
      const t = await get("/v1/tokens");
      assert.deepEqual(t.body.items.map((x) => x.tick).sort(), ["BONS", "LPAA", "LPBB", "LPCC"]);
      const h = await get("/v1/tokens/BONS/holders?limit=1");
      const top = h.body.items[0];
      const bal = await get(`/v1/addresses/${top.covenant ?? top.address}/balances`);
      assert.equal(bal.status, 200);
      assert.ok(bal.body.items.some((x) => x.tick === "BONS" && x.confirmed === top.balance), JSON.stringify({ top, bal: bal.body.items }));
      assert.equal((await get("/v1/tokens/NOPE")).status, 404);
      assert.equal((await get("/blockcount")).body, V.expect.cursor - 1);
    } finally { server.close(); reader.close(); }
  } finally { await node.close(); }
});
