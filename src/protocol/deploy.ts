// DEPLOY. Ported from crc20-stack src/indexer.mjs (applyTx, op "deploy").
//   BONS                 stored once, as written
//   before legacyDeploysUntil (mainnet 968,745): any other deploy is stored as written (history: TREE @968,598 …)
//   a bonding token      only when every rule below holds; anything else is recorded in other_deploys with the reason
import { run } from "../store/ledger.js";
import { tokenContract } from "./covenant.js";
import { ONE, parseRate, targetSatsOfRate, usdMicrosPerBtc } from "./curve.js";
import { TICK, type Ctx } from "./context.js";
import type { Marker } from "./message.js";
import { bookToken, isDeployed, oldestUsableBurn } from "./tokens.js";
import { lastOracleAtOrBelow } from "../store/ledger.js";
import type { Tx } from "./types.js";

const LAUNCH_SUPPLY = "1000000000";
const TARGET_MAX_USD = 10_000_000;
const TICKER_RE = /^[A-Z]{4}$/;

export function applyDeploy(c: Ctx, t: Tx, height: number, mk: Marker, btcUsd: string) {
  const { m, tick } = mk;
  const creator = t.vin[0]?.prevout?.scriptpubkey_address ?? null;
  const asWritten = () => run(c.db, `INSERT OR IGNORE INTO deploy(tick,type,max,lim,rate_json,deploy_txid,height,creator) VALUES(?,?,?,?,?,?,?,?)`,
    tick, (m.type as string) ?? null, String(m.max ?? ""), String(m.lim ?? ""),
    JSON.stringify({ leaf: m.leaf, ordi: m.ordi, btc: m.btc }), t.txid, height, creator);
  if (tick === TICK) return void asWritten();
  if (height < c.net.activations.legacyDeploysUntil) return void asWritten();

  const other = (reason: string) => run(c.db, "INSERT OR IGNORE INTO other_deploys(txid,tick,height,deployer,marker,reason) VALUES(?,?,?,?,?,?)",
    t.txid, tick, height, creator, JSON.stringify(m).slice(0, 2000), reason);
  if (isDeployed(c, tick)) return void other("ticker already exists");
  if (!TICKER_RE.test(tick)) return void other("ticker must be exactly 4 letters (A-Z)");
  if (m.type !== "bonding") return void other(`type ${JSON.stringify(m.type ?? null)} — not a launchpad bonding token`);
  if (String(m.max) !== LAUNCH_SUPPLY || String(m.lim) !== LAUNCH_SUPPLY) return void other("supply is not the launchpad's 1,000,000,000");
  const rateBtc = parseRate(m.btc), rateBons = parseRate(m.bons);
  if (!rateBtc || !rateBons) return void other("missing raise-token rates (btc and bons)");
  const targetSats = targetSatsOfRate(rateBtc);
  if (targetSats <= 0n) return void other("btc rate too high");
  const targetUsd = Number((targetSats * usdMicrosPerBtc(btcUsd)) / (ONE * 1_000_000n));
  if (!(targetUsd >= c.net.launchTargetMinUsd && targetUsd <= TARGET_MAX_USD)) return void other(`raise ($${targetUsd}) out of range`);
  if (!creator) return void other("no unused proof-of-burn from the creator");
  const pob = oldestUsableBurn(c, creator, height, (h) => lastOracleAtOrBelow(c.db, h) ?? btcUsd);
  if (!pob) return void other("no unused proof-of-burn from the creator");
  run(c.db, `INSERT INTO deploy(tick,type,max,lim,rate_json,deploy_txid,height,creator,target_usd,pob_txid,cmr,target_sats) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    tick, "bonding", LAUNCH_SUPPLY, LAUNCH_SUPPLY, JSON.stringify({ btc: rateBtc.toString(), bons: rateBons.toString() }),
    t.txid, height, creator, targetUsd, pob.txid, tokenContract(tick, t.txid), targetSats.toString());
  run(c.db, "INSERT INTO pob_used(burn_txid,tick,height) VALUES(?,?,?)", pob.txid, tick, height);
  bookToken(c, tick, tokenContract(tick, t.txid));          // every booked wallet's covenant for the new token (owners only)
}
