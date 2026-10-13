# Contributing

Thank you for helping. A few rules keep every node in agreement.

## Build and test

```
npm ci
npm test                 # build, unit tests, and the recorded regtest chain through a mock Bitcoin Core
npm run typecheck
```

`npm run test:e2e` runs the live regtest test. It needs a regtest node holding the reference chain and a running
`crc20 -r server --http-port 8641`; see the header of `test/e2e/live-regtest.mjs`.

## Consensus changes

Anything under `src/protocol` or `src/store` can change the ledger. A change there must:

1. Leave `npm test` passing. The regtest vector's ledger hash (`test/vectors/regtest-chain.json.gz`) must not
   change unless the change is meant to change the ledger.
2. If it changes the ledger: come with an activation height in `src/protocol/constants`, `"pending"` until one is
   agreed, a section in `docs/CONSENSUS-RULES.md`, and an entry in `CHANGELOG.md`.
3. Be checked with a mainnet replay. `crc20 index export` from scratch must print the same hash as before, unless
   the change has activated on mainnet.

Code that names owners (`linkTxKeys`, `linkBlockKeys` and the like) is not consensus. It must still be
deterministic: the same blocks must name the same owners on every node.

## Style

- TypeScript, strict. Match the code around you: short functions, comments that say why.
- Amounts are `bigint` atoms or integer sats. Never floating point in a rule.
- Protocol code never reads the clock, the environment or the network.

## Pull requests

Keep them focused. Describe what changes for a node operator and for a wallet, and say whether the index must be
rebuilt.
