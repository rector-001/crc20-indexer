# How crc20-indexer works

Modelled on [`ord`](https://github.com/ordinals/ord), the reference indexer for inscriptions and runes. It runs on
its own computer next to a Bitcoin Core node, needs nothing but that node's RPC, starts indexing at a fixed first
block, and serves a JSON API. What we take from ord, and where we differ, is listed per part.

## 1. What a node operator runs

```
bitcoind -server=1                                   # Bitcoin Core ≥ 25.0. No -txindex needed.
crc20 --chain mainnet index update                   # sync once (resumable)
crc20 --chain mainnet server --http-port 8640        # keep syncing + serve /v1
```

| Option | Default | Like ord's |
| --- | --- | --- |
| `--chain mainnet\|regtest` | mainnet | `--chain` |
| `--bitcoin-rpc-url` | `127.0.0.1:8332` / `:18443` | same |
| `--bitcoin-rpc-username` / `--bitcoin-rpc-password` or `--cookie-file` | the chain's `.cookie` in Bitcoin Core's data dir | same |
| `--bitcoin-data-dir` | `~/.bitcoin` (macOS: `~/Library/Application Support/Bitcoin`) | same |
| `--data-dir` | `~/.crc20/<chain>` | `--data-dir` |
| `--height-limit` | none | same (index up to a height, for tests and audits) |
| `--commit-interval` | 1000 blocks during initial sync, every block near the tip | `--commit-interval` (ord: 5000) |
| `--max-reorg-depth` | 24 | ord's `--savepoint-interval` × `--max-savepoints` |
| `--bitcoin-rpc-limit` | 12 requests in flight | same (Core's default `rpcworkqueue` is 16) |

## 2. First block

Like ord's `first_inscription_height` / `first_rune_height`, each chain has a fixed **first block**. Below it,
nothing can be a CRC-20 operation this indexer cares about, so it only records block hashes (for reorg
detection), never transactions.

| Chain | First block | Why |
| --- | --- | --- |
| mainnet | 967,000 | Before the BONS deploy (968,368). Earlier other-ticker deploys (TREE, MEME, PIZZA …) occupy their tickers, so they are read too |
| regtest | 1 | |

The first block is code (`src/networks`), not a setting. Starting anywhere else would build a different ledger.

## 3. Getting blocks with their prevouts: one RPC call per block

The rules need, for every input, the output it spends: the payer's address (input 0 of a mint), whether a spent
output is a token coin, and Taproot checks on witnesses.

- **ord** keeps its own UTXO table from its first height. For inputs it has never seen, it calls
  `getrawtransaction` in batches, which needs `-txindex` on the node.
- **We** call `getblock <hash> 3`. Since Bitcoin Core 25.0, verbosity 3 returns every input's `prevout` (value,
  script, address, type), read from the node's own undo data. One call per block covers everything, with no
  `-txindex` and no UTXO table of our own. A pruned node works as long as it still holds the blocks from the first
  block on.

Fetching works like ord's: a background fetcher runs ahead on its own task, holding up to 32 blocks in a bounded
queue. It retries with exponential backoff (1 s, 2 s … up to 120 s), then stops and reports.

The core receives Esplora-shaped JSON (`src/core/types.ts`). The RPC adapter converts Core's names:
- `witness_v1_taproot` becomes `v1_p2tr`;
- `nulldata` becomes `op_return`;
- BTC amounts become integer sats, parsed from the decimal string, never by floating-point multiplication.

## 4. Indexing a block

1. **Reorg check.** If this block's `previousblockhash` is not the hash stored for height − 1, walk back to the
   last height where Core and the index agree (§6).
2. **Apply the rules** to every transaction in block order (`src/core/dispatch.ts`). Each transaction is settled
   by exactly one rule, all or nothing.
3. **Record** the block hash, the per-block undo entries, and the events this block produced.
4. **Commit.** During the initial sync, many blocks go into one SQLite transaction (`--commit-interval`), like
   ord. Within `--max-reorg-depth` of the tip, every block is its own commit, so a reorg can always be undone.

The core never reads the clock, the environment or the network. Everything it needs is the block, the prevouts,
the ledger so far, the network's constants, and the pinned data.

## 5. Storage

ord uses `redb`, an embedded key-value store. We use **SQLite** (Node's built-in `node:sqlite`, no native build),
because the tables we need are relational and the API queries them directly:

| Table | Holds |
| --- | --- |
| `blocks` | height → hash, for every height from the first block |
| `coins` | every token coin: outpoint, tick, amount, owner covenant, created / spent by, status |
| `tokens` | deploys, contracts, curve inputs, raise state |
| `counters` | minted / burned / raised per token, and per curve slope |
| `events` | one row per balance change (coin created / spent / burned), ordered; it feeds `/v1/events` and activity |
| `proof_of_burn`, `bons_fills`, `launch_payments`, `launch_refunds` | launchpad bookkeeping derived from the chain |
| `owners` | covenant → proven owner wallet (a spend revealed the key, or the payer's address rebuilt the covenant) |
| `undo` | for each recent block, the exact rows it changed, so a reorg can be undone without a rebuild |

## 6. Reorgs

Same detection as ord: compare each new block's `previousblockhash` with the stored hash for the height below,
and walk back until Core and the index agree.

- **Recoverable** (depth ≤ `--max-reorg-depth`, default 24): apply the undo log of each dropped block, newest
  first, then index the new branch. ord does the same by restoring a persistent savepoint kept every 10 blocks
  near the tip. An undo log per block lets us roll back exactly the dropped blocks instead of up to 20.
- **Deeper:** stop and say so. `crc20 index rebuild` re-syncs from the first block. Mainnet has not had a reorg
  this deep since 2013.

## 7. Mempool (pending)

The server also polls `getrawmempool`, fetches new transactions with `getrawtransaction <txid> 2`, which for
mempool transactions includes their prevouts. It runs the same rules over them in order, on a throw-away overlay
of the ledger. That is what fills `pending_in`, `pending_out`, `available` and `pending: true` in the API, and
what `POST /v1/transactions/simulate` uses. Nothing from the mempool is ever written to the ledger.

## 8. API

- **Versioned and JSON only:** `/v1/…` (see [API.md](API.md)). ord serves HTML by default and JSON with
  `Accept: application/json`; we only serve JSON.
- **ord-compatible routes** for tools that already speak ord:

  | Route | Serves |
  | --- | --- |
  | `GET /status`, `/blockcount`, `/blockheight`, `/blockhash`, `/blockhash/{height}` | sync state and block info |
  | `GET /output/{outpoint}`, `POST /outputs` | what an output carries (`crc20` field next to `value`, `spent`, `address`) |
  | `GET /outputs/{address}?type=any\|cardinal\|crc20` | `cardinal` = outputs that hold no tokens (safe to spend as BTC), the same meaning as in ord |
  | `GET /tx/{txid}` | the indexer's verdict on a transaction |

## 9. What the operator can rely on

- **Same chain, same answers.** Two nodes on the same chain and release give the same answers at the same height.
  `crc20 index export --height N` writes a canonical dump with a hash, so two operators can compare.
- **Releases pin their data.** Each release pins its data files by sha256 and says which activation heights it
  knows. A node on an old release refuses to index past a height it does not know the rules for. It never
  silently guesses.

## 10. Data that is not on the chain (and how it is handled)

| Data | Handling |
| --- | --- |
| BTC/USD for the BONS mint window (heights 968,368–968,444) | Shipped as `src/pinned/mainnet-bons-mint-oracle.json` (sha256 in code). The live reference indexer took these from crc.garden's API at the time |
| BTC/USD for launch deploys and proof-of-burn since then | **Open decision** (see the release notes): pin the values the reference indexer recorded, or switch to the chain-derived UTXOracle from an announced height so nothing off-chain is needed going forward |
| BONS price for proof-of-burn | Chain-derived (`bons_fills`: marketplace sales read off the chain) |
