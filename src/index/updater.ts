// The block loop, modelled on ord's Updater: blocks come from the fetcher in order; each is checked against the stored
// hash below it (reorg), priced (oracle), and applied; many blocks share one commit during the initial sync, and near
// the tip every block is its own commit so a reorg can always be undone.
import { type Db, getBlockHash, getCursor, getOracle, putBlockHash, rewindTo, setCursor, tx } from "../store/ledger.js";
import type { Ctx } from "../protocol/context.js";
import { applyTx } from "../protocol/dispatch.js";
import { linkBlockKeys, linkTxKeys, resetKeyWatch } from "../protocol/tokens.js";
import { markersOf } from "../protocol/message.js";
import { oracleForHeight, type OracleSource } from "../protocol/oracle.js";
import { type BitcoinRpc, fetchBlocks, type FetchedBlock } from "./fetcher.js";

export interface UpdateOptions {
  commitInterval?: number;       // blocks per commit during the initial sync (default 1000)
  maxReorgDepth?: number;        // deepest reorg undone in place (default 24)
  heightLimit?: number;          // stop before this height
  log?: (m: string) => void;
  shouldStop?: () => boolean;
  /** fetch raw blocks and look prevouts up only for marker transactions (remote nodes) */
  lookup?: boolean;
  /** blocks fetched ahead of the one being indexed (default 32) */
  prefetch?: number;
  /** read raw blocks from Bitcoin Core's REST interface (bitcoind -rest=1) at this base URL */
  rest?: string;
  /** check every Taproot output key against the covenants with no owner yet (default on; not consensus) */
  linkKeys?: boolean;
}

/** Apply one block: every transaction in order. */
export function indexBlock(c: Ctx, b: FetchedBlock, oracle: OracleSource) {
  const h = b.height;
  tx(c.db, () => {
    const btcUsd = oracleForHeight(c.db, h, b.txs, oracle);
    let markers = false;
    for (const t of b.txs) {
      applyTx(c, t, h, btcUsd);
      if (markersOf(t).length) { linkTxKeys(c, t, h); markers = true; }   // proven owners of the coins it created (not consensus)
    }
    if (b.taprootKeys) linkBlockKeys(c, b.taprootKeys, h, markers);     // owners whose key shows up in any transaction
    putBlockHash(c.db, h, b.hash);
    setCursor(c.db, h + 1);
  });
}

/** Find the last height where our stored hash and Bitcoin Core agree, walking down from `height`. */
async function findFork(db: Db, rpc: BitcoinRpc, height: number, maxDepth: number): Promise<number> {
  for (let d = 1; d <= maxDepth; d++) {
    const h = height - d;
    const mine = getBlockHash(db, h);
    if (mine === null) return h + 1;                          // below the first block: nothing to compare
    if ((await rpc.getBlockHash(h)) === mine) return h + 1;   // first height to re-index
  }
  throw new Error(`reorg deeper than ${maxDepth} blocks at height ${height} — delete the index file and run \`crc20 index update\` to re-sync from the first block`);
}

/** Sync from the cursor (or the network's first block) to the tip. Resumable: stop at any time, run again. */
export async function updateIndex(c: Ctx, rpc: BitcoinRpc, oracle: OracleSource, o: UpdateOptions = {}): Promise<number> {
  const commitInterval = o.commitInterval ?? 1000, maxDepth = o.maxReorgDepth ?? 24, log = o.log ?? (() => {});
  const first = c.net.deployBlock;
  let from = getCursor(c.db) ?? first;
  for (;;) {
    const tip = await rpc.getBlockCount();
    // the node may have dropped our last block with no new block yet (a shorter or switched chain): roll back now, not
    // when the next block arrives, so the API never serves a block the node no longer has
    const last = getBlockHash(c.db, from - 1);
    if (last !== null && (from - 1 > tip || (await rpc.getBlockHash(from - 1)) !== last)) {
      const fork = await findFork(c.db, rpc, Math.min(from, tip + 1), maxDepth);
      log(`reorg below ${from}: rolling back to ${fork}`);
      rewindTo(c.db, fork); resetKeyWatch(c);
      from = fork;
    }
    let inBatch = 0, reorgAt: number | null = null;
    c.db.exec("BEGIN");
    try {
      for await (const b of fetchBlocks(rpc, from, { firstBlock: first, limit: o.heightLimit, log, lookup: o.lookup || o.rest ? c.btc : undefined, rest: o.rest, ahead: o.prefetch, keys: o.linkKeys ?? true,
        // a block's transactions are only needed when its BTC/USD must still be computed from them
        needAll: (h) => !oracle.fixedUsd && !oracle.pinned.has(h) && getOracle(c.db, h) == null })) {
        const below = getBlockHash(c.db, b.height - 1);
        if (below !== null && b.prev !== below) { reorgAt = b.height; break; }
        indexBlock(c, b, oracle);
        from = b.height + 1;
        inBatch += 1;
        // initial sync: commit every `commitInterval` blocks; within maxDepth of the tip: every block
        if (inBatch >= commitInterval || b.height >= tip - maxDepth) { c.db.exec("COMMIT"); c.db.exec("BEGIN"); inBatch = 0; }
        if (b.height % 1000 === 0) log(`indexed block ${b.height}`);
        if (o.shouldStop?.()) break;
      }
      c.db.exec("COMMIT");
    } catch (e) { try { c.db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
    if (reorgAt === null) return from;
    const fork = await findFork(c.db, rpc, reorgAt, maxDepth);
    log(`reorg at ${reorgAt}: rolling back to ${fork}`);
    rewindTo(c.db, fork); resetKeyWatch(c);
    from = fork;
  }
}
