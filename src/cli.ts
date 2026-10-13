// crc20 — the command line, ord-style. Run `crc20 --help`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS, withAddresses, type NetworkName } from "./protocol/constants/index.js";
import { makeCtx } from "./protocol/context.js";
import { loadPinnedOracle } from "./protocol/pinned.js";
import { openLedger } from "./store/ledger.js";
import { exportLedger } from "./store/export.js";
import { BitcoinRpc, defaultCookieFile, defaultRpcUrl } from "./index/fetcher.js";
import { updateIndex } from "./index/updater.js";
import { startApi } from "./api/server.js";
import { Mempool } from "./api/live.js";
import { PINNED } from "./protocol/pinned.js";
import { DatabaseSync } from "node:sqlite";

export const VERSION: string = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

/* ── flags ────────────────────────────────────────────────────────────────────────────────────────────────────────── */
type Flag = { name: string; arg?: string; help: string; boolean?: boolean; values?: string[]; number?: boolean };
const GLOBAL: Flag[] = [
  { name: "chain", arg: "CHAIN", values: ["mainnet", "regtest"], help: "Chain to index [default: mainnet]. -r is short for --chain regtest" },
  { name: "bitcoin-rpc-url", arg: "URL", help: "Bitcoin Core RPC [default: http://127.0.0.1:8332, regtest :18443]" },
  { name: "cookie-file", arg: "FILE", help: "RPC cookie file [default: <bitcoin-data-dir>/.cookie]" },
  { name: "bitcoin-data-dir", arg: "DIR", help: "Bitcoin Core data directory, to find the cookie [default: ~/.bitcoin]" },
  { name: "bitcoin-rpc-username", arg: "USER", help: "RPC user (instead of the cookie)" },
  { name: "bitcoin-rpc-password", arg: "PASS", help: "RPC password" },
  { name: "no-auth", boolean: true, help: "Send no credentials (a hosted node whose URL carries its own key)" },
  { name: "bitcoin-rpc-limit", arg: "N", number: true, help: "RPC requests in flight at once [default: 12]" },
  { name: "data-dir", arg: "DIR", help: "Where the index lives [default: ~/.crc20/<chain>]" },
  { name: "index", arg: "FILE", help: "Index file [default: <data-dir>/index.sqlite]" },
  { name: "regtest-addresses", arg: "FILE", help: "regtest only: JSON of the protocol addresses a test suite created" },
  { name: "regtest-oracle-usd", arg: "USD", number: true, help: "regtest only: a fixed BTC/USD for every block" },
  { name: "help", boolean: true, help: "Print help" },
  { name: "version", boolean: true, help: "Print version" },
];
const SYNC: Flag[] = [
  { name: "prevouts", arg: "MODE", values: ["lookup", "block"], help: "lookup: raw blocks, prevouts fetched for CRC-20 transactions only [default]; block: getblock verbosity 3 (a local node)" },
  { name: "bitcoin-rest-url", arg: "URL", help: "Read raw blocks from Bitcoin Core's REST interface (bitcoind -rest=1), e.g. http://127.0.0.1:8332" },
  { name: "prefetch", arg: "N", number: true, help: "Blocks fetched ahead of the one being indexed [default: 32]" },
  { name: "commit-interval", arg: "N", number: true, help: "Blocks per commit during the initial sync [default: 1000]" },
  { name: "height-limit", arg: "N", number: true, help: "Stop before this height" },
  { name: "link-keys", arg: "on|off", values: ["on", "off"], help: "Name coin owners from Taproot keys in every block [default: on]. Not consensus" },
];
const SERVER: Flag[] = [
  { name: "http-port", arg: "PORT", number: true, help: "API port [default: 8640]" },
  { name: "http-host", arg: "HOST", help: "Address to listen on [default: 127.0.0.1]" },
  { name: "poll-seconds", arg: "N", number: true, help: "How often to look for new blocks [default: 10]" },
  { name: "mempool", arg: "on|off", values: ["on", "off"], help: "Watch the mempool for pending balances and simulation [default: on]. Use off on a rate-limited hosted node" },
  { name: "mempool-seconds", arg: "N", number: true, help: "Mempool poll interval [default: 5]" },
];
const EXPORT: Flag[] = [{ name: "out", arg: "FILE", help: "Also write the rows to FILE" }];

const COMMANDS: { name: string; summary: string; flags: Flag[]; about: string }[] = [
  { name: "index update", summary: "Sync the index to the chain tip, then exit", flags: SYNC,
    about: "Reads every block from the chain's first block (mainnet 968,367), or from where it last stopped, up to the tip.\nStop it at any time with Ctrl-C; the next run continues." },
  { name: "index export", summary: "Print the ledger's sha256 (compare two nodes)", flags: EXPORT,
    about: "Dumps every consensus table at the current height in a fixed order and prints its sha256.\nTwo honest nodes at the same height print the same hash." },
  { name: "server", summary: "Keep syncing and serve the HTTP API", flags: [...SYNC, ...SERVER],
    about: "Syncs, then follows the tip, and serves the API (docs/API.md) from a read-only connection." },
];

function usage(cmd?: (typeof COMMANDS)[number]): string {
  const fmt = (fl: Flag[]) => fl.map((f) => `  --${f.name}${f.arg ? ` <${f.arg}>` : ""}`.padEnd(34) + f.help).join("\n");
  if (cmd) return `crc20 ${cmd.name}: ${cmd.summary}\n\n${cmd.about}\n\nUsage: crc20 [OPTIONS] ${cmd.name} [COMMAND OPTIONS]\n\nCommand options:\n${fmt(cmd.flags)}\n\nOptions:\n${fmt(GLOBAL)}\n`;
  return `crc20 ${VERSION}: an open-source indexer and API for CRC-20 tokens on Bitcoin\n\nUsage: crc20 [OPTIONS] <COMMAND>\n\nCommands:\n${COMMANDS.map((c) => `  ${c.name.padEnd(16)}${c.summary}`).join("\n")}\n\nOptions:\n${fmt(GLOBAL)}\n\nRun \`crc20 <COMMAND> --help\` for a command's options. Docs: the docs/ folder of the source.\n`;
}

class UsageError extends Error {}
function parse(argv: string[]) {
  const flags: Record<string, string> = {}, rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-r") flags.chain = "regtest";
    else if (a === "-h") flags.help = "1";
    else if (a === "-V") flags.version = "1";
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      const def = [...GLOBAL, ...SYNC, ...SERVER, ...EXPORT].find((f) => f.name === k);
      if (!def) throw new UsageError(`unknown option --${k}`);
      if (def.boolean) { flags[k] = "1"; continue; }
      const val = v ?? argv[++i];
      if (val === undefined || val.startsWith("--")) throw new UsageError(`--${k} needs a value <${def.arg}>`);
      if (def.values && !def.values.includes(val)) throw new UsageError(`--${k} must be one of: ${def.values.join(", ")}`);
      if (def.number && !(Number.isFinite(Number(val)) && Number(val) >= 0)) throw new UsageError(`--${k} must be a number`);
      flags[k] = val;
    } else rest.push(a);
  }
  return { flags, rest };
}

const CHAIN: Record<string, NetworkName> = { mainnet: "bitcoin", bitcoin: "bitcoin", regtest: "regtest" };

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  if (flags.version) { console.log(`crc20 ${VERSION}`); return; }
  const cmd = COMMANDS.find((c) => c.name === rest.join(" "));
  if (flags.help || !cmd) {
    if (!flags.help && rest.length) throw new UsageError(`unknown command '${rest.join(" ")}'`);
    process.stdout.write(usage(cmd));
    if (!flags.help) process.exitCode = 2;
    return;
  }
  const allowed = new Set([...GLOBAL, ...cmd.flags].map((f) => f.name));
  for (const k of Object.keys(flags)) if (!allowed.has(k)) throw new UsageError(`--${k} does not apply to '${cmd.name}'`);
  const chainArg = flags.chain ?? "mainnet", network = CHAIN[chainArg];
  if (!network) throw new UsageError(`unknown chain ${chainArg}`);
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
      rest: flags["bitcoin-rest-url"] || undefined, linkKeys: flags["link-keys"] !== "off" });
    console.log(JSON.stringify({ chain: chainArg, indexed_to: end - 1 }));
    return;
  }
  if (rest[0] === "server") {
    // keep syncing in this process, and serve the API from a READ-ONLY connection (it only ever sees committed blocks)
    const indexPath = flags.index ?? join(dataDir, "index.sqlite");
    const reader = new DatabaseSync(indexPath, { readOnly: true });
    const rc = makeCtx(reader, net);
    const rpc = new BitcoinRpc({ url: flags["bitcoin-rpc-url"] ?? defaultRpcUrl(chainArg),
      username: flags["bitcoin-rpc-username"], password: flags["bitcoin-rpc-password"],
      cookieFile: flags["bitcoin-rpc-username"] || flags["no-auth"] !== undefined ? undefined : (flags["cookie-file"] ?? defaultCookieFile(chainArg, flags["bitcoin-data-dir"])),
      limit: flags["bitcoin-rpc-limit"] ? Number(flags["bitcoin-rpc-limit"]) : undefined });
    let tip: number | null = null;
    const port = Number(flags["http-port"] ?? 8640);
    // pending (mempool) balances and simulations: on unless --mempool off (costly on a rate-limited hosted node)
    const mempool = flags.mempool === "off" ? null : new Mempool(rpc, indexPath, net, (m) => console.error(m));
    startApi(rc, { port, host: flags["http-host"] ?? "127.0.0.1", version: VERSION, chainTip: () => tip, dbPath: indexPath, rpc, mempool,
      pinned: Object.fromEntries((PINNED[network] ?? []).map((p) => [p.file, `sha256:${p.sha256}`])) });
    if (mempool) (async () => { for (;;) { try { await mempool.refresh(); } catch (e) { console.error(`mempool: ${(e as Error).message}`); } await new Promise((r) => setTimeout(r, Number(flags["mempool-seconds"] ?? 5) * 1000)); } })();
    console.error(`crc20 ${chainArg}: API on http://${flags["http-host"] ?? "127.0.0.1"}:${port}/v1/status`);
    const fixedUsd = network === "regtest" ? (flags["regtest-oracle-usd"] ?? null) : null;
    const pinned = loadPinnedOracle(network);
    const interval = Number(flags["poll-seconds"] ?? 10) * 1000;
    for (;;) {
      try {
        tip = await rpc.getBlockCount();
        await updateIndex(c, rpc, { pinned, fixedUsd }, { log: (m) => console.error(m), lookup: flags.prevouts !== "block",
          prefetch: flags.prefetch ? Number(flags.prefetch) : undefined, rest: flags["bitcoin-rest-url"] || undefined, linkKeys: flags["link-keys"] !== "off",
          heightLimit: flags["height-limit"] ? Number(flags["height-limit"]) : undefined });
      } catch (e) { console.error(`sync: ${(e as Error).message} — retrying`); }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  if (rest[0] === "index" && rest[1] === "export") {
    const e = exportLedger(db);
    if (flags.out) writeFileSync(flags.out, e.lines.join("\n") + "\n");
    console.log(JSON.stringify({ chain: chainArg, cursor: e.cursor, sha256: e.sha256, rows: e.rows }));
    return;
  }
}

export async function run() {
  try { await main(); }
  catch (e) {
    if (e instanceof UsageError) { console.error(`error: ${e.message}\n\nRun \`crc20 --help\` for usage.`); process.exit(2); }
    console.error(`error: ${String((e as Error)?.message ?? e)}`); process.exit(1);
  }
}
