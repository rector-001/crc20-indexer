# crc20-indexer

An open-source indexer for **CRC-20 covenant tokens** on Bitcoin: **BONS** and every **BONS launchpad token**.
It works like `ord` for runes and inscriptions. Run it next to a Bitcoin node, and it rebuilds the token ledger
from the chain and serves a public API. Wallets, explorers and exchanges can support these tokens from that API
alone.

- **Deterministic:** two nodes at the same block give the same answer. The ledger depends only on Bitcoin and the
  pinned data files shipped with each release (each with its sha256).
- **No keys:** it never signs and never holds funds.
- **Wallet-first API:** balances, token coins with everything a signer needs, protected outputs, transaction
  simulation before signing, and unsigned-PSBT builders. See [docs/API.md](docs/API.md).
- **MIT licensed.**

Scope of this release: BONS and BONS launchpad tokens. Other CRC-20 families (LEAF, AXBT…) come later, each
indexed by its own published rules.

## Quick start (target)

All you need is your own Bitcoin Core node (version 25.0 or newer) with RPC enabled. No `-txindex`, no Esplora,
no third-party API. The indexer starts at a fixed first block per chain (mainnet 968,367) and reads each block
with `getblock <hash> 3`, which includes every input's previous output.

```
npm i -g crc20-indexer
crc20 --chain mainnet index update                      # sync from the first block (resumable)
crc20 --chain mainnet server --http-port 8640           # keep syncing + serve the API
crc20 --chain mainnet index export --height 971000      # canonical ledger dump + hash, to compare two nodes
```

Credentials come from Bitcoin Core's cookie file by default (`--cookie-file`, `--bitcoin-data-dir`), or
`--bitcoin-rpc-username/--bitcoin-rpc-password`, the same as ord. A pruned node works if it still holds every
block from the first block on. How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it is built

```
src/
  index/          updater.ts (block loop) · fetcher.ts (Bitcoin Core RPC, prefetch) · reorg.ts
  protocol/       the rules, read only from the chain plus the published constants
    message.ts      reading the OP_RETURN JSON
    covenant.ts     contract leaf, covenant addresses, spend validation, burn sinks
    curve.ts        BONS curve (two slopes) · bonding-token curve (exact area)
    deploy.ts       a token and its terms
    mint.ts         a mint, paid and priced by those terms
    transfer.ts     transfer · batch · merge · burn
    oracle.ts       BTC/USD: pinned values, then the chain-derived UTXOracle
    constants/      PUBLISHED per network: curves, treasury / flywheel / holding / pre-burn
                    addresses, activation heights — code, never environment
  pinned/         data with sha256: BTC/USD for every height the reference ledger priced
  store/          SQLite ledger + reorg rewind
  api/            the /v1 JSON API + ord-compatible routes
test/
  vectors/        published test vectors: block + prevouts -> expected effects
  golden/         replay against the reference ledgers (must match row for row)
```

## Correctness plan

1. **Port, do not rewrite.** The rules are taken line by line from the indexer live on mainnet since block
   968,368 (`crc20-stack/src/indexer.mjs`). Every rule is in [docs/CONSENSUS-RULES.md](docs/CONSENSUS-RULES.md).
2. **Golden replay.** Mainnet is rebuilt from scratch and must match the reference ledger exactly: coins,
   balances, supply counters, deploys, proof-of-burn use.
3. **Test vectors** come from the reference regtest suites, which hold over 1,100 checks.
4. **Rule changes** are announced with an activation height, together with this repo's release, before they take
   effect on mainnet.

## Verified

| Chain | Blocks | Result |
| --- | --- | --- |
| mainnet | 968,367 → 971,141 (2,775 blocks, 8.6 min over a hosted RPC node) | **Identical** to the live ledger on every table that decides balances: 6,272 coins, 1,209 balances, 41 token deploys, 5,665 ledger events, 39 proof-of-burns, 1,267 BONS sales, and every supply and raise counter |
| regtest | 1 → 1,131 (reference test suites, every live rule) | **Identical**; both fetch paths (verbosity 3, and raw blocks with the marker prefilter) give the same ledger hash |

Two informational tables are not compared:
- **Proven covenant owners:** the live site also records owners from wallet connections, which is not chain data.
- **Rejected deploys from before block 969,186:** the live database started keeping that list there.

## Licence

MIT. See [LICENSE](LICENSE).
