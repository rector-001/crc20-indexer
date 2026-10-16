# How crc20-indexer works

Modelled on [`ord`](https://github.com/ordinals/ord), the reference indexer for inscriptions and runes. It runs
next to a Bitcoin Core node, needs nothing but that node's RPC, starts at a fixed first block, and serves a JSON
API. Each section says what we take from ord and where we differ.

## 1. The parts

```
src/
  bin.ts, cli.ts     the `crc20` command
  index/
    fetcher.ts       Bitcoin Core RPC: blocks fetched ahead in a bounded queue, retries, rate limits
    updater.ts       the block loop: reorg check, apply, commit
  protocol/          the rules: a pure function of (block, prevouts, ledger so far, network constants, pinned data)
    constants/       per-network constants: first block, addresses, activation heights. Code, never settings
    message.ts       reading a CRC-20 marker from an OP_RETURN
    covenant.ts      covenant addresses, spend validation, burn sinks, the fast covenant-key derivation
    curve.ts         the BONS curve (two slopes) and the launchpad curve (exact area)
    dispatch.ts      which rule settles a transaction
    deploy.ts, mint.ts, transfer.ts   the rules
    oracle.ts        BTC/USD per block: pinned values, then the chain-derived UTXOracle
    tokens.ts        token state, proof-of-burn, the BONS sale price, and owner linking (not consensus)
  pinned/            data files shipped with a release, each checked against its sha256 in code
  store/
    ledger.ts        the SQLite ledger and the reorg rollback
    export.ts        the canonical dump and its sha256
  api/
    server.ts        HTTP routes: /v1 and the ord-compatible routes
    query.ts         read queries
    live.ts          mempool overlay and transaction simulation
    build.ts         unsigned PSBT builders
```

The protocol code never reads the clock, the environment or the network. The same blocks always give the same
ledger.

## 2. First block

Like ord's `first_rune_height`, each chain has a fixed **first block**. Below it nothing is a CRC-20 operation,
so only block headers are read, for reorg detection.

| Chain | First block | Why |
| --- | --- | --- |
| mainnet | 968,367 | The block before the BONS deploy (968,368); the live ledger's first block |
| signet | 324,041 | The signet BONS deploy |
| regtest | 1 | |

The first block is in `src/protocol/constants`, not a setting. Starting anywhere else would build a different
ledger.

## 3. Getting blocks and prevouts

The rules need, for some inputs, the output being spent: the payer of a mint, whether an input is a token coin,
and the covenant leaf on a witness.

- **ord** keeps its own UTXO table and calls `getrawtransaction` for outputs it has not seen, which needs
  `-txindex`.
- **We** never need `-txindex`. Two ways, chosen with `--prevouts`:
  - **`lookup` (default).** Fetch the raw block (`getblock <hash> 0`, or Core's REST interface with
    `--bitcoin-rest-url`) and parse it here. Only transactions that carry a CRC-20 marker need prevouts, and
    they are fetched with `getrawtransaction <txid> 2 <blockhash>`. The block hash lets Core read its undo data,
    so no `-txindex` is needed.
  - **`block`.** `getblock <hash> 3`, which since Bitcoin Core 25.0 includes every input's prevout. One call per
    block, but about 4× the bytes of the raw block. Best on a fast local link.

Both give the same ledger; the test suite checks that.

**The marker prefilter.** A block with no `"crc-20"` bytes cannot hold a marker. When its BTC/USD is also already
known (pinned), the raw block is not parsed for the rules at all.

**Fetching works like ord's.** A background fetcher runs ahead, holding up to `--prefetch` blocks (default 32).
- Failing calls retry with backoff (1 s, 2 s … up to 120 s), then the sync stops and reports.
- HTTP 429 (rate limited) slows the fetcher down and is never treated as a failure.
- `--bitcoin-rpc-limit` caps the number of requests in flight (default 12).

## 4. Indexing a block

1. **Reorg check.** If the block's previous hash is not the one stored for the height below, roll back (§6).
2. **Apply the rules** to every transaction in block order. Each transaction is settled by exactly one rule, all
   or nothing.
3. **End of block:** curve-pool positions whose lock has matured are paid into their payback slots.
4. **Link owners** (§7). This is not consensus.
5. **Record** the block hash and advance the cursor.
6. **Commit.** During the initial sync, `--commit-interval` blocks (default 1,000) share one SQLite transaction,
   like ord. Within 24 blocks of the tip, every block is its own commit.

## 5. Storage

ord uses `redb`. We use **SQLite** through Node's built-in `node:sqlite` (Node ≥ 22.5): the API's queries are
relational, and there is no native build.

| Table | Holds | Consensus |
| --- | --- | --- |
| `seals` | every token coin: outpoint, tick, amount, owner covenant, status, spent by | yes |
| `balances` | per (token, covenant): the sum of its active coins. A row stays, at 0, once emptied | yes |
| `deploy`, `other_deploys` | tokens and their terms; deploys that were refused, with the reason | yes |
| `deltas` | one event per balance change, numbered; feeds `/v1/events` and the live stream | yes |
| `meta` | the cursor and the counters: minted, minted on the opening slope, burned, raised, per token | yes |
| `pob_used`, `bons_fills`, `launch_payments`, `launch_refunds` | launchpad bookkeeping read off the chain | yes |
| `blocks`, `oracle` | the hash and the BTC/USD of every indexed height | yes |
| `amm_pools`, `amm_positions`, `amm_pool_log`, `amm_share_log` | curve pools: reserves, shares, LP positions and their payback slots, and the history a reorg restores | yes |
| `covenant_owners`, `key_book`, `cov_book` | proven owners of covenants (§7) | no |

`crc20 index export` dumps every consensus table in a fixed order and prints its sha256. Two nodes at the same
height print the same hash.

## 6. Reorgs

Detection is the same as ord's. Before each sync pass, and for each new block, the stored hash is compared with
Core's. On a mismatch the indexer walks back to the last height where they agree, at most 24 blocks.

**Rollback** deletes everything the dropped blocks wrote, re-opens the coins they spent, rebuilds balances and
counters from what is left, and continues the event numbering from the last kept event. The result is
byte-for-byte the ledger a node that never saw the dropped blocks would have. The test suite rolls back to many
heights and compares each against a fresh sync to that height.

A reorg deeper than 24 blocks stops the sync with a message. Delete the index and sync again from the first
block. Mainnet has not had a reorg that deep since 2013.

## 7. Owner linking (not consensus)

A coin lives at a **covenant address**: a one-way hash of (owner key, token contract). Wallets never need the
reverse direction. A wallet asks with its own address, and the indexer derives that wallet's covenants. Explorers,
holder lists and activity feeds do need it: which wallet owns this covenant? The indexer names an owner only with
proof, from the chain alone:

| Source | Proof |
| --- | --- |
| `payer` | a mint's payer address rebuilds the covenant the coin went to |
| `input` | a funding input of the transaction that created the coin rebuilds it |
| `reveal` | a spend of the coin revealed its leaf, which contains the owner key |
| `tx-key`, `key-book` | a key seen in any CRC-20 transaction rebuilds the covenant, for every token |
| `chain-key` | a Taproot output key in **any** transaction, CRC-20 or not, rebuilds a covenant that holds coins and has no owner yet |
| `burn-sink` | the burn chain is public: each sink is owned by the one before it |

`chain-key` is what names owners who only ever received tokens. Their wallet key shows up as soon as the wallet
receives any bitcoin. After each block, every Taproot output key in it is checked against the covenants that
hold coins and have no owner yet. The check only looks forward: a key counts in the block where its covenant first
holds coins, or in any later block. So no history of keys is kept, and every node that reads the same blocks names
the same owners. Each check derives one covenant (two hashes and one elliptic-curve point addition). That runs in
libsecp256k1 when the optional native `secp256k1` package loads, and in JavaScript otherwise; the tests check
that both agree. `--link-keys off` turns the check off.

On mainnet (blocks 968,367–971,141), 946 of the 958 covenants that hold tokens are named, with no disagreement
against the live site. The other 12 belong to wallets that have not appeared on chain since the first block.

## 8. Mempool

`crc20 server` polls `getrawmempool` (every `--mempool-seconds`). It looks at each new transaction's raw bytes
for a marker, and fetches only those with one, with prevouts. Then it runs the same rules over them, parents
first, in a transaction it rolls back. That fills `pending_in`, `pending_out` and `available` in the API, and is
what `POST /v1/transactions/simulate` builds on. Nothing from the mempool is ever written to the ledger.
`--mempool off` disables it, for example on a rate-limited hosted node.

## 9. API

- **Versioned, JSON only:** `/v1/…`, described in [API.md](API.md). ord serves HTML by default; we only serve JSON.
- **ord-compatible routes** for tools that already speak ord:

  | Route | Serves |
  | --- | --- |
  | `GET /status`, `/blockcount`, `/blockheight`, `/blockhash`, `/blockhash/{height}` | sync state and block info |
  | `GET /output/{outpoint}`, `POST /outputs` | what an output carries (`crc20` next to `value`, `spent`, `address`) |
  | `GET /outputs/{address}?type=any\|cardinal\|crc20` | `cardinal` = outputs that hold no tokens, safe to spend as BTC, as in ord |
  | `GET /tx/{txid}` | the indexer's verdict on a transaction |

- The server answers from a **read-only** connection to the ledger, so it only ever sees committed blocks.

## 10. Data that is not on the chain

| Data | Handling |
| --- | --- |
| BTC/USD for every mainnet height 968,367–971,141 | `src/pinned/mainnet-oracle.json`, checked against its sha256 in code. These are the values the live ledger priced with |
| BTC/USD after that | Computed from the chain (UTXOracle, median of the last 11 blocks) and stored in the ledger, so a replay never changes it |
| The BONS price for proof-of-burn | From the chain: marketplace sales read off the chain (`bons_fills`) |

## 11. What an operator can rely on

- **Same chain, same answers.** Two nodes on the same chain and release give the same answers at the same height.
  Compare `crc20 index export` hashes.
- **Rule changes come with a height.** A new rule is published with its activation height in
  `src/protocol/constants` and shipped in a release before that height. A rule not yet scheduled on a network is
  `"pending"` there, and never active.
