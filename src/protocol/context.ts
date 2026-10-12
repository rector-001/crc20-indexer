// What every rule receives: the ledger, the network's constants, and values derived from them once.
import type * as bitcoin from "bitcoinjs-lib";
import type { Db } from "../store/ledger.js";
import type { NetworkConstants } from "./constants/index.js";
import { BONS_CMR, burnSinks, covenantOfWallet } from "./covenant.js";
import { bonsCurve, type BonsCurve } from "./curve.js";

export const TICK = "BONS";

export interface Ctx {
  db: Db;
  net: NetworkConstants;
  btc: bitcoin.Network;
  curve: BonsCurve;
  /** the direct-burn address exactly as the reference compares it: the literal mainnet string (see CONSENSUS-RULES) */
  directBurn: string;
  /** the burn address's BONS covenant on this network (launch purchases pay their 80% here) */
  burnCovenant: string;
  /** every unspendable sink on this network */
  sinks: string[];
  /** the treasury's BONS covenant (launch purchases paid in BONS pay their 20% here) */
  treasuryCovenant: string | null;
  /** VERIFICATION ONLY — never a protocol rule. Reproduces the reference indexer's old 2% per-wallet purchase cap so a
   *  replay can be compared with the reference ledger and every other difference shown to be zero. */
  compat?: { walletCap?: { from: number; until: number } };

}

export function makeCtx(db: Db, net: NetworkConstants): Ctx {
  const b = burnSinks(net.bitcoin);
  return {
    db, net, btc: net.bitcoin, curve: bonsCurve(net.bonsMax),
    directBurn: "bc1prykz5vxt6lgr2tu56np35slhvlc77s7hlajr3qucsrkqwhvp48mq5grvgr",
    burnCovenant: b.burnCovenant, sinks: b.sinks,
    treasuryCovenant: covenantOfWallet(net.addresses.treasury, BONS_CMR, net.bitcoin),
  };
}
