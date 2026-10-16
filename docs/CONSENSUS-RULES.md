# BONS consensus rules (as implemented)

Every rule our indexer applies today, written from the code (`src/indexer.mjs`, `src/curve.mjs`, `src/launchpad.mjs`,
`src/ammfee.mjs`, `src/covenant.mjs`, `src/burn.mjs`, `src/config.mjs`) on 2026-10-12. If this document and the code
disagree, the code is what runs; fix one or the other. Known problems in our own rules are listed at the end, under
**Known issues**.

## 1. Basics

- **Protocol tag:** `"p":"crc-20"`.
- **Atoms:** 1 token = 100,000,000 atoms. Every on-chain amount is an integer string in atoms; all maths is BigInt
  with no floats.
- **Marker:** an output whose script starts with `OP_RETURN`. The **last push** is read as UTF-8; it must start
  with `{` and parse as JSON, with `p = "crc-20"` and `tick` matching `/^[A-Za-z0-9]{2,8}$/`. Tickers are compared
  uppercased.
- **Marker index:** `k` is the output index of a marker. "Out k+1" is the output right after it.
- **Coins (seals):** a balance is a **coin**, a 330-sat P2TR output recorded in the ledger with
  `{tick, amount_atoms, owner_address, kind}`. Tokens move only by spending coins. A coin is `active`, `spent` or
  `voided`.
- **Covenant:** each owner has one address per token.
  - Leaf (version `0xc0`): `<32-byte CMR> OP_DROP <owner x-only key> OP_CHECKSIG`. There is **no CSV** (the one
    deliberate difference from crc.garden's leaf).
  - Internal key: the BIP-341 NUMS point `50929b74…3ac0`, so there is no key path.
  - BONS CMR: `9bc1262bec613f73c51c455b767216c0d68cfcb8bd097cd817050a30d240ac5b`.
  - A launchpad token's CMR = `sha256("crc-20:<TICK>:v1:bonding:max=1000000000:no-timelock:<deploy txid>")`.
- **Owner key from an address:** for a P2TR address the owner key is the address's own output key (crc.garden's
  rule), so `covenant(wallet) = leaf(CMR, outputKey(wallet))`.
- **A valid covenant spend** has a witness ending `[…, leaf, control block]`; the control-block length is
  1 + 32n bytes; the leaf version is `0xc0`; the internal key is NUMS; and the rebuilt address must match.
- **Processing order:** blocks in height order; transactions in block order. Each block is written atomically
  together with its block hash and cursor.
- **Reorgs:** if the stored hash of block h−1 differs from the chain, walk back to the last matching height and
  rewind every table to it (`rewindTo`).

## 2. Which rule handles a transaction

A transaction with no marker is ignored. Otherwise the first rule whose shape matches settles the transaction alone:

1. **TOKEN/BONS pool swap** (from `POOL_FROM`), §8.
2. **Curve-pool op** `amm-add` / `amm-swap` / `amm-remove` (from `AMM_FROM`), §9. A malformed one moves nothing.
3. **Split transfer** `sp-transfer` (from `LIST_SPLIT_FROM`), §7.1. An invalid one moves nothing.
4. **Merge** (from `MERGE_FROM`), §7.2.
5. Otherwise the **first marker** decides: `deploy` (§3), `mint` (§4 or §5), or `transfer` (§6, which itself tries
   launch purchase, then batch / multi-split, then single transfer).

## 3. Deploy

- **BONS** (`tick = BONS`): stored once (`INSERT OR IGNORE`); the creator is input 0's address. Mainnet deploy:
  tx `9477a33d…`, block 968,368:
  `{"p":"crc-20","op":"deploy","tick":"BONS","type":"bonding","max":"21000000","lim":"44100000","btc":"38799192"}`.
  `lim` has no effect (it is 2.1×max, as with crc.garden's LEAF).
- **Mainnet before block 968,745:** other deploys were stored as-is (e.g. TREE @968,598). This hardcoded rule is
  kept so the history replays identically.
- **Launchpad token** (otherwise). Accepted only if **all** of these hold; anything else goes to `other_deploys`
  with the reason and is never a token:
  - the ticker is new;
  - the ticker is exactly 4 letters `A–Z`;
  - `type = "bonding"`;
  - `max = lim = 1000000000`;
  - rates `btc` and `bons` are positive integer strings (`/^[1-9][0-9]{0,30}$/`);
  - `target_sats = 2.5e17 / btc` is above 0;
  - the target in USD at this block's oracle price is between **$1,000** (mainnet; test networks may lower it)
    and **$10,000,000**;
  - the creator has an **unused proof-of-burn** (§5.1). The oldest valid one is linked and marked used.
- **Stored with the token:** its own CMR, `target_sats`, `target_usd`, and `pob_txid`.

## 4. BONS mint

Marker `{"p":"crc-20","op":"mint","tick":"BONS"}`; the token must be deployed.

- **Capital:** the **sum** of every output other than the marker with value > 330 paid to `TREASURY_ADDRESS`.
  There is no per-transaction cap in consensus; the 150,000-sat cap is a builder limit, and overflow is refunded
  off-chain by the minting site.
- **Seal:** the first output other than the marker that is exactly 330 sat, `v1_p2tr`, and not a treasury
  output. Any address can receive it (gift mints are allowed).
- **Price:** the BONS curve at this block's BTC/USD (§10):
  - **The curve has two slopes:** a flat opening slope over the first 10% of supply (2,100,000 BONS, $200 across
    the whole slope), then a linear slope p0 → 4·p0 over the other 90%.
  - Which mints take the opening slope is a curve parameter (`DEPLOY` in `src/config.mjs`, applied in
    `quoteAllocation`). `p0 = 2·$35,000 / (5 · 18,900,000)` micro-USD per token. Each mint is priced at the **spot price of
    the public minted supply** for the whole mint (a snapshot, not the area under the curve).
  - `atoms = budget_µUSD · 1e8 / price`, clamped to what is left in the segment.
- **Result:** a coin of kind `allocation`; the minted counter rises; the payer's covenant is linked as owner.
- **Mainnet:** minted out at block 968,444.

## 5. Launchpad tokens

### 5.1 Proof-of-burn ($20)

- **Valid burn:** a transaction in which the creator's **BONS covenant** sent BONS to a burn sink (§11), with no
  `mint:` in the same transaction, and not used before.
- **Value:** the best BONS price in the 12 blocks up to the burn (`bonsPriceAt`, from on-chain sale fills: a
  12-block volume-weighted median, else 30 blocks, else the last 20 fills, else the BONS curve's final price) times
  the BTC/USD at those heights. It must be at least $20.

### 5.2 Purchase paid in BTC (`mint` marker for the token)

- **Status:** the raise must be `minting`. It is not if the supply is all minted (graduated) or 576 blocks have
  passed since the deploy (closed).
- **Capital:**
  - **Escrow:** if `LAUNCH_ESCROW_ADDRESS` is set and paid, everything paid to it counts.
  - **Otherwise:** `min(creator/45%, flywheel/45%, treasury/10%)` over the outputs paid to the creator,
    `PROTOCOL_FEE_ADDRESS` and `TREASURY_ADDRESS`.
- **Allocation output:** exactly 330 sat to the **payer's covenant under the token's own CMR**.
- **Amount:** exact area under the launch curve, p0 → 4·p0 over 1B tokens (`quoteLaunch`, rounded so a buy never
  pays less than the curve):
  `cost(x→x+Δ) = T·(2AΔ + 6xΔ + 3Δ²)/(5A²)`
- **Per-buyer cap (historical window):** from block 969,196 on mainnet, a purchase is capped at 2% of supply
  (20,000,000 tokens) per buyer covenant, and the rest of the payment is owed back. The cap is not in the deploy
  JSON. It stays only for the window the live indexer enforced it (11 mainnet purchases were capped), so no past
  balance changes. It ends at a removal height to be announced.
- **Shortfalls:** anything paid that bought nothing, or bought less (sold out, cap reached, closed), is written to
  `launch_refunds`. Every payment is written to `launch_payments`.

### 5.3 Purchase paid in BONS (3 markers)

- **Layout:** `transfer BONS (burn part)`, `transfer BONS (treasury part)`, `mint TOKEN`, with exactly 2 BONS coin
  inputs from the same owner. The two transfers settle as an ordinary batch (§6.2).
- **The mint credits tokens only if all of these hold:**
  - the burn part goes to the burn covenant or the pre-burn holding;
  - the treasury part goes to the treasury's covenant (or the holding);
  - `treasury = floor(P·20%)` and `burn = P − treasury`;
  - out k+1 after the mint marker is a 330 P2TR at the payer's covenant under the token CMR (payer key from the
    leaf);
  - the raise is open.
- **Amount:** `P` BONS valued at the deploy's fixed `bons` rate (`P·bons·1e6/btc` micro-sats) on the launch curve,
  with the same per-buyer cap (in its window).

## 6. Transfer (marker `op:"transfer"`)

### 6.1 Single transfer

- **Coin:** the first `active` coin among the inputs.
- **Must hold:**
  - the coin is not created by this transaction and not voided;
  - a launch-token coin reveals a valid covenant leaf whose CMR is the token's;
  - an `allocation` coin reveals a valid covenant leaf;
  - `0 < amt ≤ coin amount`;
  - out k+1 is exactly 330 sat with an address (the receiver);
  - if `amt` is less than the coin, out k+2 is exactly 330 sat with an address (the change).
- **Effect:** the coin is spent; the receiver gets a coin of `amt`; the change gets the rest. The receiver equal to
  `BURN_ADDRESS` burns `amt` (supply goes down).
- **The token moved is the coin's own token**, not the marker's (see Known issues).
- **Side records (not balances):**
  - **Owner links** from leaf reveals or paying inputs.
  - **BONS sale fill:** the coin input signed `0x83` (SIGHASH_SINGLE|ANYONECANPAY), and out 0 pays the seller's
    wallet. These fills feed the BONS price (§5.1).

### 6.2 Batch: 2+ markers, all transfers, 2+ coin inputs

- **Pairing:** marker j moves the j-th coin input, with the same checks as a single transfer.
- **Must hold:** the counts match; the output ranges do not overlap; each marker's tick equals its coin's tick.
- **All or nothing.**

### 6.3 Multi-split: 2+ transfer markers, one coin (from `MULTISPLIT_FROM`)

- **Effect:** marker j's receiver is out k_j+1; the sum must be ≤ the coin; the change is right after the last
  receiver.
- **All or nothing.**

## 7. Other moves

### 7.1 `sp-transfer` (from `LIST_SPLIT_FROM`)

- **Marker:** `{"op":"sp-transfer","tick":T,"amt":["a1","a2",…]}`, the only marker in the transaction.
- **Amounts:** 1 to 2,000 positive integer strings.
- **Coins:** one or more coins of T; each passes the merge checks (§7.2); none created by this transaction.
- **Outputs:** amount i goes to out k+1+i (each exactly 330 sat). Whatever is left becomes one change coin right
  after the last receiver.
- **All or nothing.**

### 7.2 Merge (from `MERGE_FROM`; mainnet **969,976**)

- **Shape:** exactly one marker, a `transfer`; 2+ coins of that tick; `amt` = their exact total; out k+1 exactly
  330 sat.
- **Coin check (`poolSealOk`):**
  - active and not created by this transaction;
  - launch coins reveal their own CMR;
  - allocation coins reveal a valid leaf.
- **Effect:** one coin holding the total.

## 8. TOKEN/BONS pool swap (resting offers, from `POOL_FROM`)

- **Bound triple:** a maker's offer is three inputs, each signed `0x83`:
  - input j is the offered coin, bound to out j: a transfer marker of the **other** token (what the maker wants);
  - input j+1 is a 330-sat coin, bound to out j+1: 330 sat to the maker's covenant for the wanted token;
  - input j+2 is a 330-sat coin, bound to out j+2: 330 sat back to the offered coin's own address (refund slot).
- **Valid when:**
  - every marker is a transfer;
  - per token, markers and coins pair one-to-one (each marker moves exactly its coin), or one coin to several
    markers summing exactly to it;
  - there is no change, no stray coin, no unpaid marker;
  - receivers are out k+1, and not a marker or a refund slot;
  - each coin passes `poolSealOk`.

  Then everything moves at once.
- **Invalid:** nothing moves, and **every offered coin returns to its refund slot**. A maker can never lose a coin
  to a transaction that does not pay them.

## 9. Curve pools (x·y = k, TOKEN/BONS, from `AMM_FROM`)

- **Shape:** exactly one marker, of `amm-add`, `amm-swap` or `amm-remove`.
  - The tick must be a launch token (not BONS).
  - Every coin input is of that token or of BONS, passes `poolSealOk`, and was not created by this transaction.
  - The owner (LP) is input 0's address, signed by key path (a witness of 1 item).
- **`amm-add`** `{"amt":["tok","bons"],"lock":"L"}`:
  - **Lock:** L is one of 0 / 144 / 1008 / 4320 blocks.
  - **Change slots:** out k+1 and k+2 are 330 change slots, both required.
  - **First add:** `shares = isqrt(tok·bons) − 1000`; the 1,000 shares are locked forever.
  - **Later adds:** the limiting side sets the shares, and the other side is taken at the pool ratio, rounded up.
  - **Automatic payback:** a locked add with 330 slots at out k+3 (token) and k+4 (BONS) gets paid back
    automatically at `height + L`, as coins credited into those slots with no transaction needed. Spending a slot
    early cancels the automatic payback.
- **`amm-swap`** `{"side":"buy"|"sell","amt":"in","min":"minOut"}`:
  - **Coins:** only the input token's coins; out k+1 is the output coin and out k+2 is the input change.
  - **LP fee:** 1% stays in the pool, `afterLp = floor(amt·99%)`.
  - **Protocol fee (from `AMM_FEE_FROM`):** 2% in BONS, paid as BONS coins at out k+3..k+6 to the creator /
    protocol / holders / partner covenants. The split is 0.35% / 1% / 0.35% / 0.30%; the protocol takes the
    rounding; the creator falls back to protocol. A buy pays it from the BONS input, a sell from the BONS output.
  - **Refund in full** (to out k+2) when: the output is 0, the output is below `min`, the output would drain the
    reserve, or (fee active) the 4 fee slots are missing or wrong.
- **`amm-remove`** `{"amt":"shares"}`:
  - **Inputs:** no coin inputs; the owner signs by key path.
  - **Shares:** only from unlocked positions, oldest first.
  - **Pays:** `shares/S` of each reserve, to out k+1 (token) and out k+2 (BONS).
- **Supply** is conserved: coins + pool reserves + burned = minted. Pool and share logs make every change
  rewindable.

## 10. BTC/USD oracle (used by the BONS mint and launch deploy / proof-of-burn)

- **Lookup order** per height:
  1. A cached value in the DB.
  2. Test networks only: the live spot price (cached).
  3. Mainnet at the tip: **crc.garden's `/api/oracle/btc-usd`**, if its anchor height is within ±3.
  4. Otherwise the local UTXOracle from the block's own outputs, taking the median of the last 11 blocks.
- **Every value is cached per height**; replay reads the cache. See Known issues.

## 11. Burn

- **Direct burn:** sending to `BURN_ADDRESS` (`bc1prykz5…5grvgr`, NUMS key, no script path) burns (supply goes
  down).
- **Burn sinks:** its covenant and 3 more nested covenants (`bc1pnnhy…`, `bc1pgkfn…`, `bc1ppmy5…`, `bc1p8l2k…`)
  are unspendable. Coins sent there stay in the ledger but count as burned and are never holders.

## 12. Activation heights

| Rule | Mainnet | Signet | Regtest |
| --- | --- | --- | --- |
| BONS deploy | 968,368 | 324,041 | 1 |
| Legacy deploy rule ends | 968,745 | — | — |
| Merge | **969,976** | 324,969 | 0 |
| Holding address for BTC purchases | 969,196 | — | 0 |
| Pre-burn holding for BONS purchases | 969,201 | — | 0 |
| Per-buyer 2% cap (historical) | 969,196 → removal height to be announced | 0 → 324,874 | 0 → |
| Multi-split | **971,413** | 324,769 | 0 |
| TOKEN/BONS pool swaps (resting offers) | pending | 324,927 | 0 |
| Curve pools (add / remove liquidity) + `sp-transfer` | **971,413** | 325,731 | 0 |
| Curve-pool 2% BONS fee | **971,413** | 325,964 | 0 |
| Curve-pool trades (`amm-swap`) | **971,541** | 325,731 | 0 |

"Set" means the value lives in the server env; it must be copied into this table before the spec is published.

## 13. Known issues in our own rules (fix or freeze before publishing)

1. **Consensus depends on env.**
   - Treasury, curve, fee, escrow, pre-burn, partner and holders addresses, plus every activation height, come
     from `process.env`.
   - A node with a different env builds a different ledger.
   - Fix: hardcode per network in a consensus constants file.
2. **Escrow and pre-burn are not height-gated.** `btcPurchaseCapital` accepts escrow payments whenever
   `LAUNCH_ESCROW_ADDRESS` is set, and the pre-burn covenant whenever it is configured. Both need activation
   heights.
3. **The oracle cannot be rebuilt from the chain.**
   - Mainnet BONS mints (968,368–968,444) were priced with crc.garden's live API, cached in our DB.
   - A fresh replay without that cache uses the local UTXOracle and can allocate differently.
   - Fix: publish the per-height oracle table for those blocks as pinned data with a checksum.
   - **Done:** [`pinned/mainnet-bons-mint-oracle.json`](../pinned/mainnet-bons-mint-oracle.json), 77 heights
     (968,368–968,444), every one sourced from crc.garden (`samples = -1`), 45 of them mint blocks, prices
     $83,387–84,545.
     sha256 `88f92e00b53f34c363b263d2c99884f9083715f50239b640c3b7c9d4be3db71f`.
4. **The marker's tick is not checked on a single transfer.** It moves the first active coin's token whatever
   `tick` says (§6.1). Batch, merge, sp-transfer, pool and AMM rules do check it. Fix with an activation height:
   require `marker.tick == coin.tick`.
5. **A coin spent without a marker stays `active`.** The token can never move again (the UTXO is gone), but it
   still counts in balances and supply. Fix: mark such coins `lost` (from an activation height), and show them as
   burned.
6. **Marker parsing reads the last push** of the OP_RETURN; crc.garden-family indexers read the first JSON push.
   A multi-push OP_RETURN can be read differently. Specify: exactly one push, or define which one.
7. **The 150,000-sat mint cap is not in consensus** (the builder enforces it; overflow is refunded by hand).
   Document it as a builder rule.
