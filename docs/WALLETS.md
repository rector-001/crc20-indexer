# Adding CRC-20 to a wallet

This guide covers what a wallet needs to show CRC-20 balances, send tokens safely, and stay up to date. Every
call goes to a crc20-indexer node (your own, or one you trust). Full details of each endpoint are in
[API.md](API.md).

## How tokens are held

- **A coin** is a 330-sat Taproot output that carries an amount of one token.
- **A covenant address** is where a wallet's coins of a token live. There is one per (wallet key, token), and it
  is derived from the wallet's own Taproot key. The wallet itself never holds coins at its own address.
- **A coin is spent** by script path with the wallet's key, together with a CRC-20 marker (an OP_RETURN) that
  says where the tokens go. A coin spent any other way loses its tokens.

So a wallet needs three things: to find its covenants (the indexer derives them), to never spend a coin as plain
bitcoin, and to sign coin inputs by script path.

## 1. Show balances

```
GET /v1/addresses/{wallet address}/balances
```

Pass the wallet's Taproot address (`bc1p…`). For a non-Taproot wallet, add `?public_key=<33-byte hex>`. The
response has one item per token:

| Field | Show it as |
| --- | --- |
| `confirmed` | the balance |
| `available` | what can be sent now: confirmed, minus coins a pending transaction already spends |
| `pending_in` | incoming, not yet confirmed |
| `pending_out` | outgoing, not yet confirmed |

Amounts are integer **atoms** as strings: 1 token = 100,000,000 atoms (`decimals: 8`). Never parse them into
floating-point numbers.

## 2. Receive

Give the user their normal Taproot address. A sender's wallet (or `POST /v1/build/transfer`) derives the
recipient's covenant from it. Don't ask users to share a covenant address: tokens sent to a covenant *of* a
covenant can never be spent.

## 3. Send

```
POST /v1/build/transfer
{ "from": "bc1p…", "tick": "BONS", "to": "bc1p…", "amount": "150000000000",
  "fee_rate": 4, "funding": [ { "txid": "…", "vout": 1, "value": 20000 } ] }
```

- **`funding`** is the wallet's own bitcoin outputs that pay the fee. Pick them with your normal coin selection,
  but leave out any output the indexer says carries tokens (step 5). The node keeps no list of a wallet's
  bitcoin.
- **The answer** is an unsigned PSBT, `inputs_to_sign`, the fee, and a `simulation` of the result. If
  `simulation.valid` is not `true`, do not offer the transaction.
- **`409 merge_first`** means no single coin holds the amount. Build a merge first (step 6), then send.

**Signing.** Pass `inputs_to_sign` to the wallet's `signPsbt` as `toSignInputs`. A coin input is a script-path
spend whose leaf holds the wallet's **tweaked** key: the key in its Taproot address. The entries already carry the
flags the common wallets read:

| Wallet API | Reads |
| --- | --- |
| UniSat | `useTweakedSigner: true` |
| OKX | `useTweakSigner: true`. Without it, OKX signs a tapleaf with the untweaked key and the signature is invalid |

Then finalize and broadcast through your own node or any broadcaster. Within one mempool poll, the indexer shows
the transaction as pending: `pending_out` on the sender, `pending_in` on the recipient.

## 4. Check every transaction before signing

Any transaction that spends the wallet's outputs, not only token sends, should be checked:

```
POST /v1/transactions/simulate
{ "psbt_base64": "cHNidP8…" }      or      { "tx_hex": "0200…" }
```

The response says what would move if it confirmed next, on top of everything pending. **Refuse to sign when
`valid` is `false`.** The warnings explain why:
- `coin_lost`: an input holds tokens that no rule moves. They would be destroyed.
- `nothing_moved`: the transaction carries a marker that no rule accepts.

## 5. Keep coins out of fee inputs

Coins sit at covenant addresses, so they rarely mix with a wallet's bitcoin. Check anyway, right before signing:

```
POST /v1/outputs/check
{ "outpoints": ["txid:0", "txid:1"] }
```

An output with a `token` must not be used to pay fees. The ord-compatible `GET /outputs/{address}?type=cardinal`
lists only the outputs that are safe to spend as bitcoin.

## 6. Merge coins

Every receive creates a coin, and each coin input costs about 86 vbytes. When a wallet holds many coins of one
token, offer to join them:

```
POST /v1/build/merge
{ "from": "bc1p…", "tick": "BONS", "fee_rate": 4, "funding": [ … ] }
```

It joins up to 50 coins into one. Sign and broadcast as in step 3.

## 7. Stay up to date

Poll `balances` after each block. Or keep one connection open to the event stream:

```
GET /v1/events/stream?from_id=<index of the last event you processed>
```

| Event | Do |
| --- | --- |
| `event` | a balance change, as its block is indexed. Store its `index` (also the stream's `id:`) |
| `block` | a block is fully indexed |
| `pending` | the set of pending CRC-20 transactions changed |
| `reorg` | blocks from `fork_height` up were replaced: drop what you stored from those heights |

After a disconnect, reconnect with `from_id` set to the last `index` you stored, and nothing is missed.

## Checklist

- [ ] Balances from `/balances`, with `available` as the spendable amount
- [ ] Amounts handled as integer strings
- [ ] Coin inputs signed by script path with the tweaked key
- [ ] Every transaction simulated, and refused when `valid` is `false`
- [ ] Outputs that carry tokens never used as fee inputs
- [ ] Merge offered when coins pile up
