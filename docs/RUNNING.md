# Running a node

## Requirements

| | |
| --- | --- |
| Bitcoin Core | 25.0 or newer, `server=1`. No `-txindex`. Pruned is fine if it keeps every block from 968,367 on |
| Node.js | 22.5 or newer |
| Disk | The index is about 50 MB at block 971,141 and grows with CRC-20 activity, not with the chain |
| Memory | About 600 MB during the initial sync |

## Connecting to Bitcoin Core

The indexer only needs Bitcoin Core's RPC. Choose credentials the way ord does, in this order:

| Way | Use it when | How |
| --- | --- | --- |
| **Cookie file** (the default) | the indexer runs on the same machine as Bitcoin Core | nothing to set. It reads `<bitcoin-data-dir>/.cookie` (`<bitcoin-data-dir>/regtest/.cookie` on regtest). Set `--bitcoin-data-dir` if Bitcoin Core's data is not in the default place, or `--cookie-file` for the file itself |
| **Username and password** | `rpcuser`/`rpcpassword` or `rpcauth` in `bitcoin.conf` | `--bitcoin-rpc-username` and `--bitcoin-rpc-password`, always together |
| **In the URL** | one setting for everything | `--bitcoin-rpc-url http://user:password@host:8332` |
| **No credentials** | a hosted node whose URL carries its own access key | `--bitcoin-rpc-url https://provider.example/<key>` and `--no-auth` |

- **The URL** defaults to `http://127.0.0.1:8332` (regtest `:18443`). `http://` may be left out, as in ord:
  `--bitcoin-rpc-url 192.168.1.20:8332`.
- **Bitcoin Core on another machine** must allow it: `rpcbind=` and `rpcallowip=` in its `bitcoin.conf`, and use
  a username and password, because the cookie only works locally.
- **The cookie changes every time Bitcoin Core restarts.** A running `crc20 server` reads it again by itself, so
  there is nothing to restart.

Errors say what went wrong and what to try: the cookie file can't be read, Bitcoin Core can't be reached at the
URL, it refused the credentials (HTTP 401), or it refused this machine (HTTP 403, `rpcallowip`).

### Settings: options, environment, or a file

Every option can be given three ways. As in ord, an option wins over the environment, which wins over the file,
which wins over the default.

1. **An option:** `--bitcoin-rpc-url http://127.0.0.1:8332`
2. **An environment variable:** `CRC20_` and the option's name in capitals, with `_` for `-`.
   `CRC20_BITCOIN_RPC_URL`, `CRC20_BITCOIN_RPC_USERNAME`, `CRC20_BITCOIN_RPC_PASSWORD`, `CRC20_COOKIE_FILE`,
   `CRC20_BITCOIN_DATA_DIR`, `CRC20_NO_AUTH=true`, `CRC20_CHAIN`, `CRC20_DATA_DIR`, `CRC20_HTTP_PORT`, and so on.
3. **A settings file**, `crc20.yaml`: one `name: value` per line. The file is read from `~/.crc20/crc20.yaml`,
   from `--config-dir <dir>`, or from `--config <file>`. A file passed with `--config` must exist; one in the
   default place may be missing.

```yaml
# ~/.crc20/crc20.yaml (deploy/crc20.yaml.example has every setting)
bitcoin_rpc_url: http://127.0.0.1:8332
bitcoin_rpc_username: crc20
bitcoin_rpc_password: change-me
http_port: 8640
```

Keep passwords out of shell history: put them in the file (readable only by the service user, `chmod 600`) or
in the environment. A misspelt variable (`CRC20_BITCOIN_RCP_URL`) or setting is an error, never silently
ignored.

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
| `--config`, `--config-dir` | `~/.crc20/crc20.yaml` | the settings file |
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

Settings go in `/etc/crc20/crc20.env` (environment variables) or in a `crc20.yaml`; the unit reads the first if
it exists.

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
