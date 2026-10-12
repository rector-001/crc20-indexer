#!/usr/bin/env node
// crc20 — CLI, ord-style:
//   crc20 [--chain mainnet|regtest] [--bitcoin-rpc-url URL] [--cookie-file F | --bitcoin-rpc-username U --bitcoin-rpc-password P]
//         [--bitcoin-data-dir D] [--data-dir D] [--height-limit N] [--commit-interval N] <command>
//   index update            sync from the first block (or where it stopped) to the tip
//   index export [--height N] [--out FILE]
//                           canonical dump of the ledger at the cursor + its sha256 (compare two nodes)
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { NETWORKS, withAddresses, type NetworkName } from "./protocol/constants/index.js";
import { readFileSync } from "node:fs";
import { makeCtx } from "./protocol/context.js";
import { loadPinnedOracle } from "./protocol/pinned.js";
import { openLedger, all, getCursor } from "./store/ledger.js";
import { BitcoinRpc, defaultCookieFile, defaultRpcUrl } from "./index/fetcher.js";
import { updateIndex } from "./index/updater.js";

const BOOLEAN = new Set(["no-auth"]);
function parse(argv: string[]) {
  const flags: Record<string, string> = {}, rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      flags[k] = v ?? (BOOLEAN.has(k) ? "1" : argv[++i] ?? "");
    }
    else if (a === "-r") flags.chain = "regtest";
    else rest.push(a);
  }
  return { flags, rest };
}

const CHAIN: Record<string, NetworkName> = { mainnet: "bitcoin", bitcoin: "bitcoin", regtest: "regtest" };

/** The consensus tables, in a fixed order with fixed sorting — two nodes at the same height produce the same bytes. */
export const EXPORT_TABLES: [string, string][] = [
  ["deploy", "tick"], ["other_deploys", "txid"], ["seals", "outpoint"], ["balances", "tick, address"],
  ["deltas", "id"], ["pob_used", "burn_txid"], ["bons_fills", "txid"],
  ["meta", "k"], ["blocks", "height"], ["oracle", "height"],
];

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const chainArg = flags.chain ?? "mainnet", network = CHAIN[chainArg];
  if (!network) throw new Error(`unknown chain ${chainArg}`);
  // regtest only: a test suite makes fresh wallets each run, so their addresses (and a fixed BTC/USD) are passed in
  const net = network === "regtest" && flags["regtest-addresses"]
    ? withAddresses(NETWORKS.regtest, JSON.parse(readFileSync(flags["regtest-addresses"], "utf8")))
    : NETWORKS[network];
  const dataDir = flags["data-dir"] ?? join(homedir(), ".crc20", chainArg === "bitcoin" ? "mainnet" : chainArg);
  mkdirSync(dataDir, { recursive: true });
  const db = openLedger(flags.index ?? join(dataDir, "index.sqlite"));
  const c = makeCtx(db, net);

  if (rest[0] === "index" && rest[1] === "update") {
    const rpc = new BitcoinRpc({ url: flags["bitcoin-rpc-url"] ?? defaultRpcUrl(chainArg),
      username: flags["bitcoin-rpc-username"], password: flags["bitcoin-rpc-password"],
      cookieFile: flags["bitcoin-rpc-username"] || flags["no-auth"] !== undefined ? undefined : (flags["cookie-file"] ?? defaultCookieFile(chainArg, flags["bitcoin-data-dir"])),
      limit: flags["bitcoin-rpc-limit"] ? Number(flags["bitcoin-rpc-limit"]) : undefined });
    await rpc.checkVersion();
    let stop = false;
    process.on("SIGINT", () => { stop = true; console.error("stopping after this block…"); });
    const fixedUsd = network === "regtest" ? (flags["regtest-oracle-usd"] ?? null) : null;
    const end = await updateIndex(c, rpc, { pinned: loadPinnedOracle(network), fixedUsd }, {
      commitInterval: flags["commit-interval"] ? Number(flags["commit-interval"]) : undefined,
      heightLimit: flags["height-limit"] ? Number(flags["height-limit"]) : undefined,
      log: (m) => console.error(m), shouldStop: () => stop, // default: raw blocks + prevouts only for marker transactions; --prevouts block = getblock verbosity 3
      lookup: flags.prevouts !== "block",
      prefetch: flags.prefetch ? Number(flags.prefetch) : undefined,
      rest: flags["bitcoin-rest-url"] || undefined });
    console.log(JSON.stringify({ chain: chainArg, indexed_to: end - 1 }));
    return;
  }
  if (rest[0] === "index" && rest[1] === "export") {
    const h = createHash("sha256"), lines: string[] = [];
    for (const [table, order] of EXPORT_TABLES)
      for (const r of all<Record<string, unknown>>(db, `SELECT * FROM ${table} ORDER BY ${order}`)) {
        const line = `${table}\t${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
        h.update(line + "\n"); lines.push(line);
      }
    const out = { chain: chainArg, cursor: getCursor(db), sha256: h.digest("hex"), rows: lines.length };
    if (flags.out) writeFileSync(flags.out, lines.join("\n") + "\n");
    console.log(JSON.stringify(out));
    return;
  }
  console.error("usage: crc20 [--chain mainnet|regtest] [--bitcoin-rpc-url URL] [--cookie-file F] [--data-dir D] index update | index export [--out FILE]");
  process.exitCode = 2;
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
