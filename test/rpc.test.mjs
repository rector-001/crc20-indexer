// Connecting to Bitcoin Core: every way ord supports (cookie, username + password, credentials in the URL, none),
// and the settings layers (option > CRC20_ environment variable > crc20.yaml > default).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BitcoinRpc, parseRpcUrl } from "../dist/index/fetcher.js";
import { bitcoinRpc, settings } from "../dist/cli.js";

const dir = mkdtempSync(join(tmpdir(), "crc20-rpc-"));
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

/** A JSON-RPC server that answers getblockcount and records the Authorization header; `accept` decides 401s. */
async function node(accept = () => true) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization ?? null, path: req.url });
      if (!accept(req.headers.authorization ?? null)) { res.statusCode = 401; return res.end(); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: JSON.parse(body).id, result: 42, error: null }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

test("URL: a scheme is optional, and credentials in it become the auth header", () => {
  assert.deepEqual(parseRpcUrl("127.0.0.1:8332"), { url: "http://127.0.0.1:8332", username: undefined, password: undefined });
  assert.deepEqual(parseRpcUrl("https://alice:p%40ss@node.example:443/wallet/w"), { url: "https://node.example/wallet/w", username: "alice", password: "p@ss" });
  assert.equal(parseRpcUrl("https://rpc.example/abc123key/").url, "https://rpc.example/abc123key/", "a hosted URL keeps its path and key");
});

test("auth: username and password", async () => {
  const n = await node();
  try {
    assert.equal(await new BitcoinRpc({ url: `127.0.0.1:${n.port}`, username: "u", password: "p" }).call("getblockcount"), 42);
    assert.equal(n.seen[0].auth, basic("u", "p"));
  } finally { await n.close(); }
});

test("auth: credentials written in the URL", async () => {
  const n = await node();
  try {
    await new BitcoinRpc({ url: `http://bob:secret@127.0.0.1:${n.port}` }).call("getblockcount");
    assert.equal(n.seen[0].auth, basic("bob", "secret"));
  } finally { await n.close(); }
});

test("auth: the cookie file, re-read after Bitcoin Core restarts", async () => {
  const cookie = join(dir, ".cookie");
  writeFileSync(cookie, "__cookie__:first");
  let current = basic("__cookie__", "first");
  const n = await node((a) => a === current);
  try {
    const rpc = new BitcoinRpc({ url: `127.0.0.1:${n.port}`, cookieFile: cookie });
    await rpc.call("getblockcount");
    // bitcoind restarts: a new cookie; the next call gets a 401, re-reads the file, and succeeds
    writeFileSync(cookie, "__cookie__:second"); current = basic("__cookie__", "second");
    assert.equal(await rpc.call("getblockcount"), 42);
    assert.deepEqual(n.seen.map((s) => s.auth), [basic("__cookie__", "first"), basic("__cookie__", "first"), basic("__cookie__", "second")]);
  } finally { await n.close(); }
});

test("auth: none, for a hosted URL that carries its own key", async () => {
  const n = await node();
  try {
    await new BitcoinRpc({ url: `http://127.0.0.1:${n.port}/key123` }).call("getblockcount");
    assert.deepEqual(n.seen[0], { auth: null, path: "/key123" });
  } finally { await n.close(); }
});

test("auth: errors that say what to do", async () => {
  assert.throws(() => new BitcoinRpc({ url: "127.0.0.1:1", username: "u" }), /no Bitcoin RPC password/);
  assert.throws(() => new BitcoinRpc({ url: "127.0.0.1:1", password: "p" }), /no Bitcoin RPC username/);
  assert.throws(() => new BitcoinRpc({ url: "127.0.0.1:1", cookieFile: join(dir, "missing", ".cookie") }), /cannot read Bitcoin Core's cookie file .*--bitcoin-data-dir.*--no-auth/);
  const n = await node(() => false);
  try { await assert.rejects(new BitcoinRpc({ url: `127.0.0.1:${n.port}`, username: "u", password: "bad" }).call("getblockcount"), /refused the RPC credentials/); }
  finally { await n.close(); }
  await assert.rejects(new BitcoinRpc({ url: "127.0.0.1:9", username: "u", password: "p" }).call("getblockcount"), /cannot reach Bitcoin Core at http:\/\/127\.0\.0\.1:9/);
});

test("settings: option > CRC20_ environment variable > crc20.yaml > default", () => {
  const cfg = join(dir, "crc20.yaml");
  writeFileSync(cfg, [
    "# crc20 settings",
    "bitcoin_rpc_url: http://from-file:8332",
    "bitcoin-rpc-username: file-user",
    "bitcoin_rpc_password: 'file pass'",
    "http_port: 9000",
    "mempool: off   # hosted node",
    'bitcoin_rpc_password: "p#ss word" # quoted',
    "cookie_file: ~/node/.cookie",
  ].join("\n"));
  const s = settings({ "config-dir": dir, "http-port": "7000" }, { CRC20_BITCOIN_RPC_URL: "http://from-env:8332", CRC20_NO_AUTH: "false" });
  assert.equal(s["bitcoin-rpc-url"], "http://from-env:8332", "environment beats the file");
  assert.equal(s["http-port"], "7000", "an option beats both");
  assert.equal(s["bitcoin-rpc-username"], "file-user");
  assert.equal(s["bitcoin-rpc-password"], "p#ss word", "a quoted value keeps its #; the later line wins");
  assert.equal(s["cookie-file"], join(homedir(), "node", ".cookie"), "~ is the home directory");
  assert.equal(s.mempool, "off");
  assert.equal(s["no-auth"], undefined, "CRC20_NO_AUTH=false leaves it off");
  assert.deepEqual(settings({ config: cfg }, { CRC20_NO_AUTH: "1" })["no-auth"], "1");
});

test("settings: mistakes are reported, not ignored", () => {
  assert.throws(() => settings({ "config-dir": dir }, { CRC20_BITCOIN_RCP_URL: "x" }), /unknown environment variable CRC20_BITCOIN_RCP_URL/);
  assert.throws(() => settings({ "config-dir": dir }, { CRC20_MEMPOOL: "maybe" }), /CRC20_MEMPOOL must be one of: on, off/);
  const bad = join(dir, "bad.yaml"); writeFileSync(bad, "bitcoin_rpc_urll: x\n");
  assert.throws(() => settings({ config: bad }, {}), /bad\.yaml:1: unknown setting bitcoin_rpc_urll/);
  assert.throws(() => settings({ config: join(dir, "nope.yaml") }, {}), /cannot read settings file/);
  assert.deepEqual(settings({ "config-dir": join(dir, "empty") }, {}), { "config-dir": join(dir, "empty") }, "no crc20.yaml in the default place is fine");
});

test("the CLI's client: the default cookie per chain, --no-auth, explicit credentials", async () => {
  const data = join(dir, "bitcoin");
  mkdirSync(join(data, "regtest"), { recursive: true });
  writeFileSync(join(data, "regtest", ".cookie"), "__cookie__:rt");
  const n = await node();
  try {
    await bitcoinRpc({ "bitcoin-rpc-url": `127.0.0.1:${n.port}`, "bitcoin-data-dir": data }, "regtest").call("getblockcount");
    await bitcoinRpc({ "bitcoin-rpc-url": `127.0.0.1:${n.port}`, "no-auth": "1" }, "mainnet").call("getblockcount");
    await bitcoinRpc({ "bitcoin-rpc-url": `127.0.0.1:${n.port}`, "bitcoin-rpc-username": "u", "bitcoin-rpc-password": "p", "bitcoin-data-dir": join(dir, "none") }, "mainnet").call("getblockcount");
    assert.deepEqual(n.seen.map((s) => s.auth), [basic("__cookie__", "rt"), null, basic("u", "p")]);
  } finally { await n.close(); }
});
