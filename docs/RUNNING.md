# Running a node

## Requirements

| | |
| --- | --- |
| Bitcoin Core | 25.0 or newer, `server=1`. No `-txindex`. Pruned is fine if it keeps every block from 968,367 on |
| Node.js | 22.5 or newer |
| Disk | The index is about 50 MB at block 971,141 and grows with CRC-20 activity, not with the chain |
| Memory | About 600 MB during the initial sync |

## Options

`crc20 --help` and `crc20 <command> --help` list them all.

| Option | Default | |
| --- | --- | --- |
| `--chain mainnet\|regtest` | `mainnet` | `-r` is short for `--chain regtest` |
| `--bitcoin-rpc-url` | `http://127.0.0.1:8332` (regtest `:18443`) | |
| `--bitcoin-data-dir` | `~/.bitcoin` (macOS `~/Library/Application Support/Bitcoin`) | where the cookie file is |
| `--cookie-file` | `<bitcoin-data-dir>/.cookie` | |
| `--bitcoin-rpc-username`, `--bitcoin-rpc-password` | | instead of the cookie |
| `--no-auth` | | a hosted node whose URL carries its own key |
| `--bitcoin-rpc-limit` | 12 | RPC requests in flight |
| `--data-dir` | `~/.crc20/<chain>` | |
| `--index` | `<data-dir>/index.sqlite` | |
| `--prevouts lookup\|block` | `lookup` | `block` reads `getblock <hash> 3`: fewer calls, 4× the bytes. Good on a local node |
| `--bitcoin-rest-url` | | read raw blocks from Core's REST interface (`bitcoind -rest=1`), the fastest source |
| `--prefetch` | 32 | blocks fetched ahead |
| `--commit-interval` | 1000 | blocks per commit during the initial sync |
| `--height-limit` | | stop before this height |
| `--link-keys on\|off` | `on` | owner linking from Taproot keys in every block (not consensus) |
| `server`: `--http-host`, `--http-port` | `127.0.0.1`, `8640` | |
| `server`: `--poll-seconds` | 10 | how often to look for a new block |
| `server`: `--mempool on\|off`, `--mempool-seconds` | `on`, 5 | pending balances and simulation |

## The first sync

```
crc20 index update
```

It reads every block from 968,367 to the tip, then exits. Stop it any time with Ctrl-C; it finishes the current
block, and the next run continues from there. Then start the server, which keeps following the tip.

| Source | Time to block 971,141 |
| --- | --- |
| A hosted node over the internet (`--prevouts lookup --bitcoin-rpc-limit 4`) | about 12 minutes |
| Bitcoin Core on the same machine | faster: no network round trips |

Most of the time goes to downloading blocks. To go faster on a local node, use `--bitcoin-rest-url
http://127.0.0.1:8332` (start `bitcoind` with `-rest=1`). If the native `secp256k1` package did not install
(check `npm ls secp256k1`), owner linking falls back to JavaScript and the sync takes about 2.5× as long.
`--link-keys off` skips owner linking entirely.

## Running as a service

`deploy/crc20.service` is a systemd unit with the usual hardening.

```
sudo useradd --system --home /var/lib/crc20 crc20
sudo usermod -aG bitcoin crc20             # so it can read Bitcoin Core's cookie file
sudo cp deploy/crc20.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now crc20
journalctl -u crc20 -f
```

The API binds to `127.0.0.1`. To serve it publicly, put a reverse proxy with TLS in front (Caddy, nginx). The API
is read-only, sends open CORS headers, and has no keys. Rate-limit at the proxy if the node is public. Stopping
the service is safe at any moment. SQLite rolls back whatever was not committed: up to `--commit-interval` blocks
during the initial sync, one block near the tip. Those blocks are indexed again on restart.

## Checking a node

```
curl -s 127.0.0.1:8640/v1/status          # indexed height, chain tip, synced
crc20 index export                        # {"cursor":…, "sha256":…}
```

Two honest nodes at the same height print the same `sha256`. Compare yours with another operator's, or with the
hash published with a release.

## Reorgs

Handled automatically up to 24 blocks deep: the ledger is rolled back exactly and the new blocks are indexed. A
deeper reorg stops the sync with a message. Then delete the index file and run `crc20 index update` again.

## Upgrades

Releases follow [semantic versioning](https://semver.org), and [CHANGELOG.md](../CHANGELOG.md) says for each one
whether the index must be rebuilt.

- **Rule changes** ship in a release before their activation height. A node that is not upgraded in time keeps
  applying the old rules and drifts from everyone else at that height. Watch the releases.
- **Rebuild** when the changelog says so: stop the node, delete `<data-dir>/index.sqlite`, and sync again.
