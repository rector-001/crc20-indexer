# crc20-indexer

An open-source indexer for **CRC-20 covenant tokens** on Bitcoin: **BONS** and every **BONS launchpad token**.
It works like [`ord`](https://github.com/ordinals/ord) does for runes and inscriptions. Run it next to a Bitcoin
node, and it rebuilds the token ledger from the chain and serves a public API. Wallets, explorers and exchanges can
support these tokens from that API alone.

- **Deterministic.** Two nodes at the same block give the same answer. The ledger depends only on Bitcoin and the
  data files shipped with each release, each checked against its sha256.
- **Only a Bitcoin node.** Bitcoin Core's RPC, from a fixed first block. No `-txindex`, no Esplora, no third-party
  API.
- **No keys.** It never signs and never holds funds.
- **Wallet-first API.** Balances with pending amounts, coins with everything a signer needs, transaction
  simulation before signing, unsigned PSBT builders, and a live event stream. See [docs/API.md](docs/API.md).
- **MIT licensed.**

## Status

| | |
| --- | --- |
| **BONS** | Supported |
| **BONS launchpad tokens** | Supported |
| **LEAF and other CRC-20 tokens** | Full support coming soon, each indexed by its own published rules |
| **precop-indexer** | A patch so [precop-indexer](https://github.com/Laz1mov/precop-indexer) fully indexes BONS and BONS launchpad tokens will be published soon |

## How to run

**1. Bitcoin Core.** Version 25.0 or newer, fully synced, with RPC on. In `bitcoin.conf`:

```
server=1
```

No `-txindex` is needed. A pruned node works if it still holds every block from 968,367 on.

**2. Install.** You need Node.js 22.5 or newer.

```
git clone https://github.com/rector-001/crc20-indexer
cd crc20-indexer
npm ci && npm run build
npm link                     # puts `crc20` on your PATH
```

`npm ci` also tries to install `secp256k1`, Bitcoin Core's elliptic-curve library, prebuilt for Linux x64,
macOS arm64 and Windows x64. It is optional. It makes owner linking about 7× faster, and without it the indexer
uses a JavaScript implementation that gives the same results.

**3. Sync.** Reads every block from 968,367 to the tip, then exits. Stop it any time with Ctrl-C; the next run
continues where it stopped.

```
crc20 index update
```

**4. Serve the API.** Keeps following the tip and serves the API on `127.0.0.1:8640`.

```
crc20 server
```

**5. Check it.**

```
curl -s 127.0.0.1:8640/v1/status                     # indexed height, chain tip, synced
curl -s 127.0.0.1:8640/v1/tokens                     # every token
curl -s 127.0.0.1:8640/v1/addresses/<bc1p…>/balances # a wallet's balances
crc20 index export                                   # the ledger's sha256, to compare with another node
```

**Connecting to Bitcoin Core:**
- **Credentials** come from Bitcoin Core's cookie file by default (`--bitcoin-data-dir`, `--cookie-file`), or
  `--bitcoin-rpc-username` and `--bitcoin-rpc-password`, the same as ord.
- **A node on another machine:** `--bitcoin-rpc-url http://host:8332`.
- **A hosted node** (a URL that carries its own key): add `--no-auth`. If it rate-limits, add
  `--bitcoin-rpc-limit 4`, and `--mempool off` with `server`.

`crc20 --help` lists every command and option. Running it as a service, tuning and upgrades are in
[docs/RUNNING.md](docs/RUNNING.md). Adding CRC-20 to a wallet is in [docs/WALLETS.md](docs/WALLETS.md).

## Documentation

| | |
| --- | --- |
| [docs/RUNNING.md](docs/RUNNING.md) | Operating a node: requirements, options, systemd, performance, upgrades |
| [docs/WALLETS.md](docs/WALLETS.md) | Integrating a wallet: balances, sending, signing, simulation, live updates |
| [docs/API.md](docs/API.md) | Every endpoint |
| [docs/CONSENSUS-RULES.md](docs/CONSENSUS-RULES.md) | The rules, exactly |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works, and how it compares with ord |

## Verified

| What | Result |
| --- | --- |
| **Mainnet replay**, blocks 968,367 → 971,141 (2,775 blocks), from scratch over a hosted RPC node | **Identical** to the live ledger on every consensus table: 6,272 coins, 1,209 balances, 41 token deploys, 5,665 ledger events, 39 proof-of-burns, 1,267 BONS sales, every supply and raise counter. 11.7 minutes, owner linking included |
| **Owners named from the chain alone** (mainnet) | 946 of the 958 covenants that hold tokens, 0 disagreements with the live site. The other 12 belong to wallets that have not appeared on chain since the first block |
| **Test suite** (`npm test`) | Unit tests on real mainnet vectors. A recorded regtest chain (every launch rule, transfers, merges, burns) replayed through a mock Bitcoin Core: both fetch modes reach the expected ledger hash, a stopped sync resumes to the same hash, and rollback to any height equals a fresh sync to that height |
| **Live regtest** (`npm run test:e2e`) | Build → sign with a real key → broadcast → confirm, then a reorg. Pending balances, simulation (including a transaction that would lose a coin), merge, and the event stream |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md); do not open a public issue.

## Licence

MIT. See [LICENSE](LICENSE).
