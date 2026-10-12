// Pinned data: BTC/USD values the reference ledger used, shipped with the release. Each file's sha256 is written here,
// so a node refuses to start on a file that was changed.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkName } from "./constants/index.js";

/** file name -> sha256 of its exact bytes */
export const PINNED: Partial<Record<NetworkName, { file: string; sha256: string }[]>> = {
  // every height the reference ledger priced, 968,367 – 971,141 (the BONS mint window inside it matches mainnet-bons-mint-oracle.json)
  bitcoin: [{ file: "mainnet-oracle.json", sha256: "e3ce68062b88b7d43b74c6b78e1df16be19197fd9275b7405ebbed4836b6bc4e" }],
};

const here = dirname(fileURLToPath(import.meta.url));
/** src/pinned when run from source, dist/pinned when built */
const pinnedDir = () => [join(here, "..", "pinned"), join(here, "..", "..", "src", "pinned")].find((d) => existsSync(d)) ?? join(here, "..", "pinned");

export function loadPinnedOracle(network: NetworkName): Map<number, { price: string; samples: number }> {
  const out = new Map<number, { price: string; samples: number }>();
  for (const p of PINNED[network] ?? []) {
    const bytes = readFileSync(join(pinnedDir(), p.file));
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== p.sha256) throw new Error(`pinned file ${p.file} does not match its published sha256 (${got} != ${p.sha256})`);
    const j = JSON.parse(bytes.toString("utf8")) as { rows: { height: number; price_usd: string; samples: number }[] };
    for (const r of j.rows) out.set(r.height, { price: String(r.price_usd), samples: r.samples });
  }
  return out;
}
