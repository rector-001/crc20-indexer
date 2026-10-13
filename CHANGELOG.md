# Changelog

Every release says whether the index must be rebuilt (delete `index.sqlite` and sync again) and which rule
activation heights it knows. Rule changes are published here before their activation height.

## Unreleased: 0.1.0

The first public release. **Rebuild:** not applicable (new index).

### Indexing
- BONS and BONS launchpad tokens on mainnet from block 968,367, by the rules in `docs/CONSENSUS-RULES.md`.
  Rebuilding from scratch matches the live ledger on every consensus table (blocks 968,367–971,141).
- Only Bitcoin Core's RPC is needed: no `-txindex`. Raw blocks with prevouts fetched only for CRC-20
  transactions (`--prevouts lookup`, the default), or `getblock` verbosity 3 (`--prevouts block`), or Core's REST
  interface (`--bitcoin-rest-url`).
- Reorgs up to 24 blocks are rolled back exactly, including when the node's tip drops with no new block.
- Owners of covenants named from the chain alone, including from Taproot keys in any transaction
  (`--link-keys`). Optional native libsecp256k1 for speed.

### Connecting to Bitcoin Core (as in ord)
- Credentials: the cookie file (default, re-read when Bitcoin Core restarts), `--bitcoin-rpc-username` with
  `--bitcoin-rpc-password`, credentials in the URL (`http://user:pass@host:port`), or none (`--no-auth`).
  `http://` may be left out of the URL.
- Every option can also be a `CRC20_<NAME>` environment variable or a line in `crc20.yaml` (`--config`,
  `--config-dir`, default `~/.crc20/crc20.yaml`). An option wins over the environment, which wins over the file.
- Clear errors for an unreadable cookie, an unreachable node, refused credentials (401) and `rpcallowip` (403).

### API
- `/v1`: tokens, holders, activity, wallet balances (with pending amounts), coins with signing data, covenants,
  outputs, transactions (pending ones too), blocks, events, and the ord-compatible routes.
- `POST /v1/transactions/simulate`, `POST /v1/build/transfer`, `POST /v1/build/merge`, `GET /v1/events/stream`.

### Known activation heights (mainnet)
- Merge: 969,976. Launch holding address: 969,196. Pre-burn holding covenant: 969,201.
- Launch wallet cap: from 969,196, no end height yet.
