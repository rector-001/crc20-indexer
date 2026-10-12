// The transaction shape the core reads (Esplora JSON, which Bitcoin Core blocks are converted to). Only these fields are
// used, so a block source must fill them — `prevout` on every input included.

export interface TxOut {
  value: number;                     // sats
  scriptpubkey: string;              // hex
  scriptpubkey_type?: string;        // "v1_p2tr", "v0_p2wpkh", "op_return", …
  scriptpubkey_address?: string;     // absent for OP_RETURN / non-standard
}

export interface TxIn {
  txid: string;
  vout: number;
  witness?: string[];                // hex items
  prevout: TxOut | null;
  sequence?: number;
  is_coinbase?: boolean;            // Esplora's flag; the RPC adapter sets it too
}

export interface Tx {
  txid: string;
  vin: TxIn[];
  vout: TxOut[];
}

export interface Block {
  height: number;
  hash: string;
  txs: Tx[];
}
