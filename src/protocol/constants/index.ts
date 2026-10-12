// Per-network consensus constants. These are CODE, reviewed like consensus code — never read from the environment
// (the reference indexer took them from env, so a node with a different env built a different ledger).
import * as bitcoin from "bitcoinjs-lib";

export type NetworkName = "bitcoin" | "regtest";

/** A rule's status on a network: active from a height, or "pending" (published, not activated, never applied).
 *  Rules not listed here (deploy, mint, single transfer, batch transfer, BONS-paid purchase) are always active. */
export type Activation = number | "pending";

export interface Activations {
  /** one marker, 2+ coins of one token, amt = their total -> one coin */
  merge: Activation;
  /** before this height every non-BONS deploy is stored as written (mainnet history: TREE @968598) */
  legacyDeploysUntil: number;
}

/** Is a rule in force at `height`? A pending rule never is. */
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
    /** receives BONS mint payments; 10% of BTC purchases in the 45/45/10 split; 20% of BONS purchases (as its covenant) */
    treasury: string;
    /** mints paid from this address take the BONS curve's opening slope */
    curveOpeningPayer: string | null;
    /** the flywheel: 45% of BTC purchases in the 45/45/10 split */
    protocolFee: string | null;
    /** the holding address: from `from`, a BTC purchase may pay its whole amount here instead of the 45/45/10 split */
    launchEscrow: { address: string; from: number } | null;
    /** the pre-burn holding (a BONS covenant): from `from`, a BONS purchase may pay its 80% — or all of it — here */
    launchPreburnCovenant: { covenant: string; from: number } | null;
  };
  /** the lowest bonding-token raise target accepted, in USD */
  launchTargetMinUsd: number;
  activations: Activations;
}

export const NETWORKS: Record<NetworkName, NetworkConstants> = {
  bitcoin: {
    name: "bitcoin",
    bitcoin: bitcoin.networks.bitcoin,
    deployBlock: 967000,
    bonsMax: 21_000_000n,
    bonsLim: 44_100_000n,
    addresses: {
      treasury: "bc1pwlvtk7xvg7n3tulsaxzx8ckh8z5c9l8mwsnqeps5xu45rth4z3jsr5t2sq",          // mint tx d0392344…, output 2
      curveOpeningPayer: "bc1psnnur93sd59mxc53qk5w7v4tjq9wgcdejq0ag4vn4cphjsa5aq2q3ee5hm",   // input 0 of the opening-slope mints
      // flywheel: 45% of BCAT's BTC purchases (tx 02104aec…, output 2) — also takes the 3,000-sat BONS mint fee
      protocolFee: "bc1p9nzm4vf9waecsmnhe0dz8ha2mpryx9uwnu8yysy8uxzdhp76c3zqpl6yf0",
      // every BTC purchase of every token but BCAT paid here (first: tx 5ef62919…, block 969,196)
      launchEscrow: { address: "bc1ptpxpph8a5m05mmq5m5d5u0ldzd4wv5y4hct58z5a6qhd3mrnlrqq0dpuzc", from: 969196 },
      // BONS purchases paid their 80% + 20% here (first: tx e14094d5…, block 969,201); BCAT's earlier BONS purchases
      // paid the burn covenant and the treasury
      launchPreburnCovenant: { covenant: "bc1plxjz7dre8hlsgmxtwac66tysxaz7klm9dcva43x3lucez02v2cxsueeev9", from: 969201 },
    },
    launchTargetMinUsd: 1_000,
    activations: {
      merge: 969976,
      legacyDeploysUntil: 968745,
    },
  },
  regtest: {
    name: "regtest",
    bitcoin: bitcoin.networks.regtest,
    deployBlock: 1,
    bonsMax: 2_000_000n,
    bonsLim: 2_000_000n,
    // the regtest suites generate these per run; set them with withAddresses() in tests
    addresses: { treasury: "", curveOpeningPayer: null, protocolFee: null, launchEscrow: null, launchPreburnCovenant: null },
    launchTargetMinUsd: 1_000,
    activations: {
      merge: 0,
      legacyDeploysUntil: 0,
    },
  },
};

/** A copy of a network with some addresses replaced (regtest suites, which make fresh wallets each run). */
export function withAddresses(n: NetworkConstants, a: Partial<NetworkConstants["addresses"]>): NetworkConstants {
  return { ...n, addresses: { ...n.addresses, ...a } };
}
