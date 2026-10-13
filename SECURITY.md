# Security

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub's private vulnerability reporting: the
**Security** tab of this repository, then **Report a vulnerability**. Include what an attacker can do, the steps
or the transaction that shows it, and the release you tested.

We acknowledge within 72 hours. We agree a fix and a disclosure date with you, and credit you unless you ask us
not to.

## What counts

- **Consensus:** two nodes on the same chain disagree, or a transaction moves, creates or destroys tokens
  against the rules in `docs/CONSENSUS-RULES.md`.
- **Wallet safety:** `POST /v1/transactions/simulate`, `POST /v1/outputs/check` or a builder says a transaction is
  safe when it would lose tokens, or a builder produces a transaction that does.
- **The node:** a request that crashes the server or makes it serve wrong data.

## What the indexer does not do

It holds no keys and signs nothing. The API is read-only. A node only serves what it indexed from its own Bitcoin
Core, so run your own, or check a public node's `crc20 index export` hash against another.
