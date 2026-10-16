# crc20-indexer API (v1)

A read API over the CRC-20 ledger. A Bitcoin wallet, explorer or exchange can support BONS and every BONS launchpad
token from this API alone. It is modelled on what `ord` serves for runes and inscriptions, and on the
address/token/UTXO endpoints wallets such as UniSat already use for BRC-20 and runes.

Every node computes the same ledger from Bitcoin plus the pinned data shipped with the release. Any two
honest nodes at the same height answer the same.

## Status in this release (0.1)

| Implemented | Coming next |
| --- | --- |
| `/v1/status`, `/v1/rules`, `/v1/tokens`, `/v1/tokens/{tick}` (+ `/holders`, `/activity`), `/v1/addresses/{address}/` (`balances`, `coins` with signing data, `covenants`, `activity`, `protected-outputs`), `/v1/outputs/{outpoint}`, `POST /v1/outputs/check`, `/v1/transactions/{txid}` (pending ones too), `/v1/blocks/{height}`, `/v1/events`, the ord-compatible routes; pending (mempool) balances and coins, `POST /v1/transactions/simulate`, `GET /v1/events/stream`, `POST /v1/build/transfer`, `POST /v1/build/merge` | `/v1/tokens/{tick}/quote/mint`, `POST /v1/build/purchase`, batch sends in the builder, the UniSat-style aliases |

`crc20 server --http-port 8640` keeps syncing and serves the API from a read-only connection, so an answer only
ever reflects committed blocks.

## Conventions

| | |
| --- | --- |
| Base | `http://<host>:<port>/v1` (default port 8640) |
| Format | JSON; `Content-Type: application/json` |
| Amounts | integer **atoms** as decimal strings, with `decimals` (8 for every token today). Never JSON numbers |
| Heights | every response carries `indexed_height` and `indexed_hash`, the block it is true at |
| Mempool | `balances` and `coins` add pending fields by default when the node watches the mempool; `?mempool=0` returns confirmed state only. `crc20 server --mempool off` turns watching off (use it on a rate-limited hosted node) |
| Lists | newest first; `?limit=` (default 50, max 500) and `?cursor=` (opaque, from `next_cursor`; `null` = end) |
| Errors | HTTP 4xx/5xx with `{"error":{"code":"…","message":"…"}}` |
| CORS | open (`*`), no credentials; no API keys on a self-hosted node |
| Tickers | case-insensitive in paths, returned uppercase |

### Words used below

- **Token coin:** a 330-sat Taproot output holding an amount of one token. Tokens only move by spending coins.
- **Covenant address:** where a wallet's coins of a token live. It is derived from the wallet's key and the token's
  contract (CMR).
  - Leaf: `<CMR> OP_DROP <owner key> OP_CHECKSIG`, with the NUMS internal key.
  - Each wallet has one covenant address per token.
  - A Taproot wallet's key is its address's own output key, so a `bc1p…` address alone is enough. Other address
    types need `public_key`.
- **Owner:** the wallet that controls a covenant address.

## 1. Node

### `GET /v1/status`
Sync state and identity of this node.
```json
{ "network": "mainnet", "version": "1.0.0", "protocol": "crc-20",
  "indexed_height": 971678, "indexed_hash": "0000…", "chain_tip": 971678, "synced": true, "first_block": 968368,
  "mempool": { "enabled": true, "txs": 214 },
  "pinned": { "oracle": "sha256:88f92e00…3db71f" } }
```
Exchanges should wait for `synced: true` and `indexed_height ≥` their transaction's block before trusting a "not found".

### `GET /v1/rules`
Every consensus constant this node applies, for auditing two nodes against each other. A rule is either active from
a height or `"pending"`: published, but not activated on this network, so never applied (a transaction using it
moves nothing, and `GET /v1/transactions/{txid}` says which pending rule it would need). On mainnet every swap rule
is active except resting TOKEN/BONS pool offers (`poolSwap`); curve-pool trades (`ammSwap`) from block 971,541.
```json
{ "network": "mainnet", "first_block": 968368,
  "contracts": { "BONS": "9bc1262bec613f73c51c455b767216c0d68cfcb8bd097cd817050a30d240ac5b" },
  "bonding_contract": "sha256(\"crc-20:<TICK>:v1:bonding:max=1000000000:no-timelock:<deploy txid>\")",
  "burn_sinks": ["bc1prykz5…", "bc1pnnhy…", "bc1pgkfn…", "bc1ppmy5…", "bc1p8l2k…"],
  "activations": { "merge": 969976, "multiSplit": 971413, "poolSwap": "pending", "amm": 971413, "spTransfer": 971413,
                   "ammFee": 971413, "ammSwap": 971541, "launchWalletCap": { "from": 969196, "until": null }, "legacyDeploysUntil": 968745 },
  "addresses": { "treasury": "bc1pwlvtk7…", "curve_opening_payer": "…", "flywheel": "…", "holding": { … }, "preburn": { … } },
  "bonding": { "supply": "1000000000", "raise_closes_after_blocks": 576,
               "split_btc_bps": { "creator": 4500, "flywheel": 4500, "treasury": 1000 }, "split_bons_bps": { "burn": 8000, "treasury": 2000 } } }
```

## 2. Tokens

### `GET /v1/tokens`
Every token this node indexes.
```json
{ "items": [
  { "tick": "BONS", "kind": "bons", "decimals": 8, "max_supply": "2100000000000000", "minted": "2100000000000000",
    "burned": "…", "circulating": "…", "holders": 412, "deploy_txid": "9477a33d…", "deploy_height": 968368,
    "contract": "9bc1262b…", "status": "complete" },
  { "tick": "LPBB", "kind": "launch", "decimals": 8, "max_supply": "100000000000000000", "minted": "…",
    "status": "minting", "raise": { "target_sats": "…", "raised_sats": "…", "closes_at_height": 971500 } } ],
  "next_cursor": null, "indexed_height": 971040 }
```
`status`: `complete` (BONS), `minting`, `graduated` (all minted), `closed` (576 blocks passed).

### `GET /v1/tokens/{tick}`
One token in full: its deploy JSON as written on chain, contract, curve, raise, supply figures, pool (if any).
```json
{ "tick": "LPBB", "kind": "launch", "deploy": { "txid": "…", "height": 970900, "creator": "bc1p…",
    "marker": {"p":"crc-20","op":"deploy","tick":"LPBB","type":"bonding","max":"1000000000","lim":"1000000000","btc":"…","bons":"…"},
    "proof_of_burn_txid": "…" },
  "contract": "…", "curve": { "shape": "linear", "start_to_end": 4, "target_sats": "…", "rates": { "btc": "…", "bons": "…" } },
  "supply": { "max": "…", "minted": "…", "burned": "…", "circulating": "…", "in_pools": "…" },
  "raise": { "status": "minting", "raised_sats": "…", "closes_at_height": 971476 },
  "pool": { "reserve_token": "…", "reserve_bons": "…", "shares": "…" } }
```

### `GET /v1/tokens/{tick}/holders`
Holders by **owner wallet** (a covenant whose owner is not yet proven is listed by its covenant address, `owner: null`).
`?include=coins` adds each holder's coins.
```json
{ "items": [ { "owner": "bc1p…", "covenant": "bc1p…", "balance": "…", "coins": 3, "share": "0.0412" } ], "next_cursor": "…" }
```

### `GET /v1/tokens/{tick}/activity`
Every operation of the token, newest first (same item shape as address activity below). `?op=mint,transfer,burn,merge,split,pool_swap,amm_add,amm_swap,amm_remove,amm_payback,refund`.

### `GET /v1/tokens/{tick}/quote/mint?sats=…&payer=…`
The tokens a mint/purchase of this size would allocate **if mined in the next block** at today's state (curve,
raise left). It is advisory: the block it lands in decides.
```json
{ "sats": "100000", "tokens": "…", "price_sats_per_token": "…", "capped_by": null, "refund_sats": "0" }
```

## 3. Wallets and addresses (what a wallet extension needs)

`{address}` can be a **wallet** address (the API then resolves its covenant address for every token) or a
**covenant** address directly. For a non-Taproot wallet pass `?public_key=<33-byte hex>`.

### `GET /v1/addresses/{address}/balances`
Every token balance of a wallet, the first call a wallet makes.
```json
{ "address": "bc1p…", "kind": "wallet",
  "items": [
    { "tick": "BONS", "decimals": 8, "covenant": "bc1p…", "confirmed": "123450000000", "coins": 2,
      "pending_in": "0", "pending_out": "5000000000", "available": "118450000000" } ],
  "indexed_height": 971040 }
```
- **`available`:** confirmed, minus coins already spent by an unconfirmed transaction.
- **`pending_in`:** tokens arriving: transfers to you, purchases, and the change of your own send.
- **`pending_out`:** confirmed coins an unconfirmed transaction spends, whether or not it carries a marker (a
  spend without one is caught through Bitcoin Core's `gettxspendingprevout`).
- The response also carries `mempool: { txs, updated_at }`. The pending figures come from running the same rules
  over the pending CRC-20 transactions (parents first) on a rolled-back copy of the ledger.

### `GET /v1/addresses/{address}/coins`
The coins a wallet uses to build a transfer. `?tick=` filters.
```json
{ "items": [
  { "outpoint": "txid:1", "tick": "BONS", "amount": "100000000000", "value_sats": 330,
    "covenant": "bc1p…", "owner_key": "84e7…", "status": "confirmed", "height": 970101, "spent_by": null,
    "spend": { "leaf_script": "20<cmr>7520<owner>ac", "leaf_version": 192, "control_block": "c050929b…" } } ],
  "next_cursor": null }
```
`spend` is everything a wallet's signer needs for the script-path input (`tapLeafScript`) of a PSBT.

### `GET /v1/addresses/{address}/covenants`
A wallet's covenant address for each token, including tokens it holds none of yet. Use it to show a receive
address or to check that a deposit address is right.
```json
{ "owner_key": "84e7…", "items": [ { "tick": "BONS", "contract": "9bc1…", "covenant": "bc1p…", "leaf_script": "…", "control_block": "…" } ] }
```

### `GET /v1/addresses/{address}/activity`
What happened to this wallet's tokens, newest first. `?tick=` filters.
```json
{ "items": [
  { "txid": "…", "height": 971030, "time": "2026-10-12T02:10:00Z", "confirmations": 11, "pending": false,
    "op": "transfer", "tick": "BONS", "direction": "in", "amount": "…",
    "from": { "owner": "bc1p…", "covenant": "bc1p…" }, "to": { "owner": "bc1p…", "covenant": "bc1p…" } } ],
  "next_cursor": "…" }
```
`direction`: `in` · `out` · `self` (a merge or a change-only move). Exchanges credit `in` items with enough
`confirmations`, deduplicated by `txid` + `tick`.

### `GET /v1/addresses/{address}/protected-outputs`
Outputs at **this address** that must not be spent as plain BTC. A wallet calls this before choosing fee inputs,
the same way UniSat keeps inscriptions and runes out of fee inputs. Coins sit at covenant addresses, so a normal
wallet address rarely has any. The endpoint exists for addresses that receive coins directly (pool payback slots,
covenant addresses imported as watch-only).
```json
{ "items": [ { "outpoint": "txid:3", "reason": "token_coin", "tick": "BONS", "amount": "…" },
             { "outpoint": "txid:4", "reason": "pool_payback_slot", "tick": "LPBB", "matures_at": 971900 } ] }
```

## 4. Outputs and transactions

### `GET /v1/outputs/{txid}:{vout}`
What an output carries, like `ord`'s `/output`.
```json
{ "outpoint": "txid:1", "value_sats": 330, "address": "bc1p…",
  "token": { "tick": "BONS", "amount": "…", "status": "active", "kind": "seal", "created": { "txid": "…", "height": 970101 }, "spent_by": null } }
```
`token: null` = this output holds no tokens. 404 = this node never saw the output.

### `POST /v1/outputs/check`
Several outputs in one call. A wallet runs it on its chosen inputs right before signing.
```json
{ "outpoints": ["txid:0", "txid:1"] }
```
```json
{ "items": [ { "outpoint": "txid:0", "token": null }, { "outpoint": "txid:1", "token": { "tick": "BONS", "amount": "…" } } ] }
```

### `GET /v1/transactions/{txid}`
The indexer's verdict on a transaction: which rule settled it, what moved, or why nothing did.
```json
{ "txid": "…", "height": 971030, "pending": false,
  "rule": "transfer", "valid": true,
  "markers": [ { "vout": 0, "json": {"p":"crc-20","op":"transfer","tick":"BONS","amt":"5000000000"} } ],
  "spent": [ { "outpoint": "…:1", "tick": "BONS", "amount": "…", "owner": "bc1p…" } ],
  "created": [ { "outpoint": "…:1", "tick": "BONS", "amount": "…", "covenant": "bc1p…", "role": "receiver" },
               { "outpoint": "…:2", "tick": "BONS", "amount": "…", "covenant": "bc1p…", "role": "change" } ],
  "burned": [], "pool": null, "notes": [] }
```
- **`rule`:** `deploy`, `mint`, `launch_purchase`, `transfer`, `batch`, `multi_split`, `sp_transfer`, `merge`,
  `pool_swap`, `amm_add`, `amm_swap`, `amm_remove`, or `none`.
- **When `valid: false`:** `reason` says which check failed, and `refunds` lists any coins the rules returned
  (pool swaps and `amm-swap`).

### `POST /v1/transactions/simulate`
**Before you sign or broadcast:** what this transaction would do if it confirmed next, computed by the same rules
on top of the current state, pending transactions included. The single most useful call for a wallet: it shows the
user exactly what moves, and flags a transaction that would lose tokens.
```json
{ "tx_hex": "0200…" }        or        { "psbt_base64": "cHNidP8…" }
```
Signed or unsigned. Prevouts come from the PSBT's `witnessUtxo`, then the ledger's own coins, then Bitcoin Core
(`gettxout`). An unsigned covenant input is checked with the leaf its PSBT `tapLeafScript` will reveal.

Response:
```json
{ "txid": "…", "rule": "transfer", "valid": true,
  "spent":   [ { "outpoint": "…:1", "tick": "BONS", "amount": "…", "covenant": "bc1p…" } ],
  "created": [ { "outpoint": "…:1", "tick": "BONS", "amount": "…", "covenant": "bc1p…", "kind": "seal" } ],
  "events":  [ { "op": "transfer", "tick": "BONS", "from": "bc1p…", "to": "bc1p…", "amount": "…" } ],
  "warnings": [], "on_top_of_pending": 0 }
```
- **`rule`:** `mint`, `launch_purchase`, `transfer`, `batch`, `merge`, or `none`.
- **`valid: false`** when any of these warnings is present:
  - `coin_lost`: an input is a token coin that no rule moves, so its tokens would be lost.
  - `nothing_moved`: the transaction carries a marker that no rule accepts.
- **Other warnings:**
  - `no_marker`: a plain Bitcoin transaction that touches no coin.
  - `unsigned`: signatures were not checked.
- The price used for a mint is the last indexed block's BTC/USD; the real one is the confirming block's.

### Pending transactions
`GET /v1/transactions/{txid}` also answers for a pending CRC-20 transaction, with `pending: true` and the same
`spent`/`created`/`events` as a simulation. `GET /v1/addresses/{address}/coins` adds `pending_spent_by` (txid or
`null`) to each coin, and lists `arriving` coins.

## 5. Pools

| Endpoint | Returns |
| --- | --- |
| `GET /v1/pools` | every curve pool (TOKEN/BONS): reserves, shares, price, 24h volume |
| `GET /v1/pools/{tick}` | one pool, plus its recent swaps |
| `GET /v1/pools/{tick}/positions?owner=` | LP positions: shares, lock, automatic payback slots, value now |
| `GET /v1/pools/{tick}/quote?side=buy\|sell&amount=` | output for an `amm-swap` of that size at today's reserves, with the 1% LP fee and the 2% fee split |

## 6. Blocks and events (exchanges and explorers)

| Endpoint | Returns |
| --- | --- |
| `GET /v1/blocks/{height}` | every CRC-20 operation in that block, in order, plus its hash |
| `GET /v1/events?from_height=&to_height=&tick=` | a flat ordered list of every balance change (one row per coin created / spent / burned) for following the ledger without per-address polling. Every row carries `height`, `block_hash`, `txid`, `index`, so a consumer can detect a reorg by hash and re-read |
| `GET /v1/events/stream?from_id=&tick=` | server-sent events, described below |

### `GET /v1/events/stream`
A `text/event-stream` connection. The events are:
- `hello`: sent first, with `{indexed_height, indexed_hash, from_id}`.
- `event`: one row of `/v1/events` as its block is indexed. The SSE `id` is the row's `index`.
- `block`: `{height, hash}` after each block's rows.
- `reorg`: `{fork_height}` when blocks are rolled back. Drop what you hold at or above that height; the rows are
  sent again as the new blocks are indexed.
- `pending`: `{txs}`, the pending CRC-20 transactions' effects, whenever the set changes.

`?from_id=N` first replays every row after `N`, so a client that reconnects with its last id misses nothing.
Without it, the stream starts at the current tip.

## 7. Builders (optional helpers)

Unsigned PSBTs a wallet signs with its own key (`signPsbt` in UniSat, Xverse, OKX). They are conveniences: anyone
can build the same transactions from the coin data above. The node never sees a key or a signature, and keeps no
list of the wallet's BTC outputs, so the caller passes the outputs that pay the fee.

| Endpoint | Builds |
| --- | --- |
| `POST /v1/build/transfer` | send tokens: `{ from, public_key?, tick, to, amount, fee_rate, funding: [{txid, vout, value}], change? }`. Spends the smallest single coin that covers `amount`. Output 0 is the marker, output 1 the recipient's coin, output 2 your change coin (when part stays), then BTC change. `to` is a Taproot wallet (its covenant is derived) or a covenant that already holds the token. If no single coin covers the amount, the answer is `409 merge_first` |
| `POST /v1/build/merge` | join coins of one token into one: `{ from, public_key?, tick, fee_rate, funding, outpoints? }`. Up to 50 coins; all of them unless `outpoints` picks some. Only where the merge rule is active |

Coins already spent by a pending transaction are never picked. A funding output that holds tokens is refused.
Every builder answers with:
```json
{ "psbt_base64": "…",
  "inputs_to_sign": [
    { "index": 0, "address": "bc1p…", "publicKey": "…", "sighashTypes": [0], "useTweakedSigner": true, "useTweakSigner": true, "disableTweakSigner": false },
    { "index": 1, "address": "bc1p…", "useTweakedSigner": true } ],
  "fee_sats": 722, "vsize": 361, "fee_rate": 2,
  "simulation": { /* POST /v1/transactions/simulate of the PSBT, on top of pending transactions */ } }
```
A coin input is spent by script path and signed with the wallet's **tweaked** key, the address key the leaf holds.
UniSat reads `useTweakedSigner`. OKX reads `useTweakSigner`; without it, OKX signs a tapleaf with the untweaked key
and the signature is invalid. Pass `inputs_to_sign` straight to `signPsbt`'s `toSignInputs`.

## 8. Compatibility layer (optional)

For wallets that already speak UniSat's open API, a node can serve the same data under the paths those wallets
call. These are aliases of the endpoints above; the same numbers come back in that API's field names.

| Alias path | Serves |
| --- | --- |
| `/v1/indexer/address/{address}/crc20/summary` | balances |
| `/v1/indexer/address/{address}/crc20/{tick}/info` | one token's balance |
| `/v1/indexer/crc20/{tick}/info` | `/v1/tokens/{tick}` |
| `/v1/indexer/crc20/{tick}/holders` | holders |
| `/v1/indexer/address/{address}/crc20/{tick}/utxo` | coins |

## 9. What the API never does

- **No signing and no keys.** It never asks for a private key or a signature.
- **No off-chain state in answers.** It never mixes in marketplace listings or swap offers: those are application
  state, not ledger state.
- **No guessing.** A covenant whose owner is not proven is shown as `owner: null`.
