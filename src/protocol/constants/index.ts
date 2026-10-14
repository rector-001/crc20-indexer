// Per-network consensus constants. These are CODE, reviewed like consensus code — never read from the environment
// (the reference indexer took them from env, so a node with a different env built a different ledger).
import * as bitcoin from "bitcoinjs-lib";

export type NetworkName = "bitcoin" | "signet" | "regtest";

/** A rule's status on a network: active from a height, or "pending" — published but not activated, so never applied.
 *  Rules not listed here (deploy, mint, single transfer, batch transfer, BONS-paid purchase) are always active. */
export type Activation = number | "pending";

export interface Activations {
  /** one marker, 2+ coins of one token, amt = their total -> one coin */
  merge: Activation;
  /** one coin, 2+ transfer markers -> one receiver per marker */
  multiSplit: Activation;
  /** resting TOKEN/BONS offers (bound triples) */
  poolSwap: Activation;
  /** curve pools: amm-add / amm-swap / amm-remove */
  amm: Activation;
  /** sp-transfer: one marker, amt is a list */
  spTransfer: Activation;
  /** the curve pools' 2% fee paid in BONS coins */
  ammFee: Activation;
  /** curve-pool TRADES (amm-swap): before it a trade is refunded in full and the pool does not move (liquidity can already
   * be added and removed from `amm`) */
  ammSwap: Activation;
  /** before this height every non-BONS deploy is stored as written (mainnet history: TREE @968598) */
  legacyDeploysUntil: number;
  /** HISTORICAL: a bonding-token purchase is capped at 2% of supply (20,000,000 tokens) per buyer covenant, from `from`
   *  until `until` (exclusive; null = until a removal height is announced). The reference indexer enforced it on
   *  mainnet from 969,196 and capped 11 purchases; it stays for that window so no past balance changes. */
  launchWalletCap: { from: number; until: number | null } | null;
}

/** Is `rule` in force at `height`? A pending rule never is. */
export const isActive = (a: Activation, height: number): boolean => a !== "pending" && height >= a;

export interface NetworkConstants {
  name: NetworkName;
  bitcoin: bitcoin.Network;
  /** no block before this height is read */
  deployBlock: number;
  /** BONS curve size (whole tokens) */
  bonsMax: bigint;
  bonsLim: bigint;
  addresses: {
    /** receives BONS mint payments; 10% of BTC launch purchases; 20% of BONS launch purchases (as its covenant) */
    treasury: string;
    /** mints paid from this address take the BONS curve's opening slope */
    curveOpeningPayer: string | null;
    /** 45% of BTC launch purchases ("flywheel"); the protocol share of the curve-pool fee */
    protocolFee: string | null;
    /** the holders' share of the curve-pool fee */
    holders: string | null;
    /** the partner's share of the curve-pool fee */
    partner: string | null;
    /** the holding address: from `from`, a BTC purchase may pay its whole amount here instead of the 45/45/10 split */
    launchEscrow: { address: string; from: number } | null;
    /** the pre-burn holding (a BONS covenant): from `from`, a BONS purchase may pay its 80% — or all of it — here
     *  instead of the burn covenant and the treasury */
    launchPreburnCovenant: { covenant: string; from: number } | null;
  };
  /** the lowest launch raise target accepted, in USD */
  launchTargetMinUsd: number;
  activations: Activations;
}

export const NETWORKS: Record<NetworkName, NetworkConstants> = {
  bitcoin: {
    name: "bitcoin",
    bitcoin: bitcoin.networks.bitcoin,
    deployBlock: 968367,                         // the live ledger's first block (BONS deploys at 968,368)
    bonsMax: 21_000_000n,
    bonsLim: 44_100_000n,
    addresses: {
      treasury: "bc1pwlvtk7xvg7n3tulsaxzx8ckh8z5c9l8mwsnqeps5xu45rth4z3jsr5t2sq",          // mint tx d0392344…, output 2
      curveOpeningPayer: "bc1psnnur93sd59mxc53qk5w7v4tjq9wgcdejq0ag4vn4cphjsa5aq2q3ee5hm",   // input 0 of the opening-slope mints
      // flywheel: 45% of BCAT's BTC purchases (tx 02104aec…, output 2) — also takes the 3,000-sat BONS mint fee
      protocolFee: "bc1p9nzm4vf9waecsmnhe0dz8ha2mpryx9uwnu8yysy8uxzdhp76c3zqpl6yf0",
      holders: "bc1p8kgysmvye0nqkzk9smq2jtk5w7kw7lyywszgn83zxs9aezaglgqs9qdkkr",   // the BONS reflection wallet
      partner: "bc1pvlqh9xuj94xptwamqa6t60d03vg3zhnpexlr8g3nkvkg26mg2hgsz9unc4",
      // every BTC purchase of every token but BCAT paid here (first: tx 5ef62919…, block 969,196)
      launchEscrow: { address: "bc1ptpxpph8a5m05mmq5m5d5u0ldzd4wv5y4hct58z5a6qhd3mrnlrqq0dpuzc", from: 969196 },
      // BONS purchases paid their 80% + 20% here (first: tx e14094d5…, block 969,201); BCAT's earlier BONS purchases
      // paid the burn covenant and the treasury
      launchPreburnCovenant: { covenant: "bc1plxjz7dre8hlsgmxtwac66tysxaz7klm9dcva43x3lucez02v2cxsueeev9", from: 969201 },
    },
    launchTargetMinUsd: 1_000,
    activations: {
      // live on mainnet: merge. Published but pending on mainnet (live on signet): the rest.
      // 2026-10-14: the new rules from block 971,413; curve-pool trades and resting offers not yet
      merge: 969976, multiSplit: 971413, poolSwap: "pending", amm: 971413, spTransfer: 971413, ammFee: 971413, ammSwap: "pending",
      launchWalletCap: { from: 969196, until: null },   // the live config (BONS_LAUNCH_WALLET_CAP_FROM); removal height to be announced
      legacyDeploysUntil: 968745,
    },
  },
  signet: {
    name: "signet",
    bitcoin: bitcoin.networks.testnet,
    deployBlock: 324041,
    bonsMax: 21_000_000n,
    bonsLim: 44_100_000n,
    addresses: {
      treasury: "tb1pgy9j34s83mz80tz42ucjm8txxwn3uc46jl5c8e9mna9u0nlmtd0seyt2t9",
      curveOpeningPayer: "tb1pg60edsngpjzz57cmtgn57pajzge05lhfqnrmlyz6lm09k46mfd7q03uftp",
      protocolFee: "tb1pskhs8h30yzuqlhgsrx0xvwg9x4u6yh40uzhhwfe0zln84ck4vwzqzcf4f6",
      holders: "tb1pql0lyjmdckcnjm7afr2ecyvn70e9zjsn9mnl5y537s7894rr4dwqz4ehq7",
      partner: "tb1prg96tagj7cmcgrn34gewshm0437qwguvcng7q695cu87v6jjeecqyrx05s",
      launchEscrow: null,
      launchPreburnCovenant: null,
    },
    launchTargetMinUsd: 1_000,
    activations: {
      merge: 324969, multiSplit: 324769, poolSwap: 324927, amm: 325731, spTransfer: 325731, ammFee: 325964, ammSwap: 325731,
      launchWalletCap: { from: 0, until: 324874 },      // signet: BONS_LAUNCH_WALLET_CAP_UNTIL
      legacyDeploysUntil: 0,
    },
  },
  regtest: {
    name: "regtest",
    bitcoin: bitcoin.networks.regtest,
    deployBlock: 1,
    bonsMax: 2_000_000n,
    bonsLim: 2_000_000n,
    // the regtest suites generate these per run; set them with withAddresses() in tests
    addresses: { treasury: "", curveOpeningPayer: null, protocolFee: null, holders: null, partner: null, launchEscrow: null, launchPreburnCovenant: null },
    launchTargetMinUsd: 1_000,
    activations: {
      merge: 0, multiSplit: 0, poolSwap: 0, amm: 0, spTransfer: 0, ammFee: 0, ammSwap: 0,
      launchWalletCap: { from: 0, until: null },        // the reference regtest suites test the cap
      legacyDeploysUntil: 0,
    },
  },
};

/** A copy of a network with some addresses replaced (regtest suites, which make fresh wallets each run). */
export function withAddresses(n: NetworkConstants, a: Partial<NetworkConstants["addresses"]>): NetworkConstants {
  return { ...n, addresses: { ...n.addresses, ...a } };
}
