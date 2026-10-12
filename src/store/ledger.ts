// The ledger: SQLite (node:sqlite, no native build). Table and column names are the reference indexer's
// (crc20-stack src/db.mjs) so a replay can be compared row for row. Only CONSENSUS state lives here — nothing an
// application (marketplace, swap offers, payouts) adds.
//
// Determinism: no timestamps, no random ids. `deltas.id` is insertion order, which is block order.
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openLedger(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deploy (
      tick TEXT PRIMARY KEY, type TEXT, max TEXT, lim TEXT, rate_json TEXT, deploy_txid TEXT, height INTEGER, creator TEXT,
      target_usd INTEGER, pob_txid TEXT, cmr TEXT, target_sats TEXT);
    CREATE TABLE IF NOT EXISTS other_deploys (txid TEXT PRIMARY KEY, tick TEXT, height INTEGER NOT NULL, deployer TEXT, marker TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS balances (tick TEXT NOT NULL, address TEXT NOT NULL, atoms TEXT NOT NULL DEFAULT '0', PRIMARY KEY(tick,address));
    CREATE TABLE IF NOT EXISTS seals (
      outpoint TEXT PRIMARY KEY, tick TEXT NOT NULL, txid TEXT, vout INTEGER, height INTEGER,
      owner_address TEXT NOT NULL, amount_atoms TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'seal',
      status TEXT DEFAULT 'active', spent_txid TEXT, bucket TEXT);
    CREATE INDEX IF NOT EXISTS seals_owner ON seals(tick, owner_address);
    CREATE INDEX IF NOT EXISTS seals_owner_status ON seals(owner_address, status);
    CREATE INDEX IF NOT EXISTS seals_txid ON seals(txid);
    CREATE INDEX IF NOT EXISTS seals_spent_txid ON seals(spent_txid);
    CREATE TABLE IF NOT EXISTS deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, height INTEGER, txid TEXT, op TEXT, from_addr TEXT, to_addr TEXT, atoms TEXT);
    CREATE INDEX IF NOT EXISTS deltas_txid ON deltas(txid);
    CREATE INDEX IF NOT EXISTS deltas_op_to ON deltas(op, to_addr);
    CREATE INDEX IF NOT EXISTS deltas_from ON deltas(from_addr, height);
    CREATE INDEX IF NOT EXISTS deltas_height ON deltas(height);
    CREATE TABLE IF NOT EXISTS oracle (height INTEGER PRIMARY KEY, price_usd TEXT NOT NULL, samples INTEGER);
    CREATE TABLE IF NOT EXISTS covenant_owners (covenant_address TEXT PRIMARY KEY, wallet_address TEXT, owner_xonly TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS bons_fills (txid TEXT PRIMARY KEY, height INTEGER NOT NULL, sats INTEGER NOT NULL, atoms TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bons_fills_h ON bons_fills(height);
    CREATE TABLE IF NOT EXISTS pob_used (burn_txid TEXT PRIMARY KEY, tick TEXT NOT NULL, height INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS launch_payments (txid TEXT PRIMARY KEY, tick TEXT, height INTEGER, pay TEXT, payer TEXT, to_creator TEXT, to_flywheel TEXT,
      to_treasury TEXT, to_hold TEXT, hold_address TEXT, outcome TEXT);
    CREATE TABLE IF NOT EXISTS launch_refunds (txid TEXT PRIMARY KEY, tick TEXT, height INTEGER, pay TEXT, payer TEXT, paid_json TEXT,
      paid_total TEXT, used TEXT, refund TEXT, reason TEXT);
  `);
  return db;
}

let sp = 0;
/** Run fn inside a savepoint: all of it, or none of it. */
export function tx<T>(db: Db, fn: () => T): T {
  const name = `sp_${sp++}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const r = fn(); db.exec(`RELEASE ${name}`); return r; }
  catch (e) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw e; }
}

/** A statement whose integer results come back as BigInt (a launch token's 1e17 atoms exceed JS's safe range). */
export const bigRead = (st: StatementSync): StatementSync => { st.setReadBigInts(true); return st; };

/* ── meta: cursor and counters ─────────────────────────────────────────────────────────────────────────────────────── */
export const getMeta = (db: Db, k: string, d: string | null = null): string | null => (db.prepare("SELECT v FROM meta WHERE k=?").get(k) as { v: string } | undefined)?.v ?? d;
export const setMeta = (db: Db, k: string, v: string | number | bigint) => db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v));
export const getCursor = (db: Db): number | null => { const v = getMeta(db, "cursor"); return v == null ? null : Number(v); };
export const setCursor = (db: Db, h: number) => setMeta(db, "cursor", h);
const big = (db: Db, k: string) => BigInt(getMeta(db, k, "0")!);
export const getMintedAtoms = (db: Db, tick: string) => big(db, `minted_atoms:${tick}`);
export const addMintedAtoms = (db: Db, a: bigint, tick: string) => setMeta(db, `minted_atoms:${tick}`, getMintedAtoms(db, tick) + a);
/** atoms minted on the BONS curve's opening slope */
export const getOpeningMintedAtoms = (db: Db, tick: string) => big(db, `opening_minted_atoms:${tick}`);
export const addOpeningMintedAtoms = (db: Db, a: bigint, tick: string) => setMeta(db, `opening_minted_atoms:${tick}`, getOpeningMintedAtoms(db, tick) + a);
export const getPublicMintedAtoms = (db: Db, tick: string) => getMintedAtoms(db, tick) - getOpeningMintedAtoms(db, tick);
export const getBurnedAtoms = (db: Db, tick: string) => big(db, `burned_atoms:${tick}`);
export const addBurnedAtoms = (db: Db, a: bigint, tick: string) => setMeta(db, `burned_atoms:${tick}`, getBurnedAtoms(db, tick) + a);
export function addRaiseSats(db: Db, sats: bigint, tick: string, height: number, txid: string) {
  setMeta(db, `raise:${tick}`, big(db, `raise:${tick}`) + sats);
  delta(db, height, txid, `raise:${tick}`, null, null, sats);
}

/* ── blocks ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export const putBlockHash = (db: Db, h: number, hash: string) => db.prepare("INSERT INTO blocks(height,hash) VALUES(?,?) ON CONFLICT(height) DO UPDATE SET hash=excluded.hash").run(h, hash);
export const getBlockHash = (db: Db, h: number): string | null => (db.prepare("SELECT hash FROM blocks WHERE height=?").get(h) as { hash: string } | undefined)?.hash ?? null;

/* ── coins (seals) and balances ─────────────────────────────────────────────────────────────────────────────────────── */
export interface Seal { outpoint: string; tick: string; txid: string; vout: number; height: number; owner_address: string; amount_atoms: string; kind: string; status: string; spent_txid: string | null; bucket: string | null }

function credit(db: Db, address: string, atoms: bigint, tick: string) {
  const cur = BigInt((db.prepare("SELECT atoms FROM balances WHERE tick=? AND address=?").get(tick, address) as { atoms: string } | undefined)?.atoms ?? "0");
  db.prepare("INSERT INTO balances(tick,address,atoms) VALUES(?,?,?) ON CONFLICT(tick,address) DO UPDATE SET atoms=excluded.atoms").run(tick, address, (cur + atoms).toString());
}
function debit(db: Db, address: string, atoms: bigint, tick: string) {
  const cur = BigInt((db.prepare("SELECT atoms FROM balances WHERE tick=? AND address=?").get(tick, address) as { atoms: string } | undefined)?.atoms ?? "0");
  if (cur < atoms) throw new Error(`insufficient ${tick} balance for ${address}`);
  db.prepare("UPDATE balances SET atoms=? WHERE tick=? AND address=?").run((cur - atoms).toString(), tick, address);
}

export function createSeal(db: Db, s: { outpoint: string; tick: string; txid: string; vout: number; height: number; owner_address: string; amount_atoms: bigint | string; kind?: string; bucket?: string | null }) {
  const r = db.prepare(`INSERT OR IGNORE INTO seals(outpoint,tick,txid,vout,height,owner_address,amount_atoms,kind,status,bucket) VALUES(?,?,?,?,?,?,?,?, 'active', ?)`)
    .run(s.outpoint, s.tick, s.txid, s.vout, s.height, s.owner_address, String(s.amount_atoms), s.kind ?? "seal", s.bucket ?? null);
  // the reference credits even when the INSERT was ignored (a duplicate outpoint); kept identical
  void r;
  credit(db, s.owner_address, BigInt(s.amount_atoms), s.tick);
}
export function spendSeal(db: Db, outpoint: string, spentTxid: string): Seal | null {
  const seal = db.prepare("SELECT * FROM seals WHERE outpoint=? AND status='active'").get(outpoint) as Seal | undefined;
  if (!seal) return null;
  db.prepare("UPDATE seals SET status='spent', spent_txid=? WHERE outpoint=?").run(spentTxid, outpoint);
  debit(db, seal.owner_address, BigInt(seal.amount_atoms), seal.tick);
  return seal;
}
export const getSeal = (db: Db, outpoint: string): Seal | null => (db.prepare("SELECT * FROM seals WHERE outpoint=?").get(outpoint) as Seal | undefined) ?? null;

/* ── events (deltas) ────────────────────────────────────────────────────────────────────────────────────────────────── */
export function delta(db: Db, height: number, txid: string, op: string, from: string | null, to: string | null, atoms: bigint | string) {
  db.prepare("INSERT INTO deltas(height,txid,op,from_addr,to_addr,atoms) VALUES(?,?,?,?,?,?)").run(height, txid, op, from, to, String(atoms));
}

/* ── oracle ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export const getOracle = (db: Db, h: number): string | null => (db.prepare("SELECT price_usd FROM oracle WHERE height=?").get(h) as { price_usd: string } | undefined)?.price_usd ?? null;
export const putOracle = (db: Db, h: number, price: string, samples: number) => db.prepare("INSERT OR REPLACE INTO oracle(height,price_usd,samples) VALUES(?,?,?)").run(h, price, samples);
export const lastOracleAtOrBelow = (db: Db, h: number): string | null =>
  (db.prepare("SELECT price_usd FROM oracle WHERE height<=? ORDER BY height DESC LIMIT 1").get(h) as { price_usd: string } | undefined)?.price_usd ?? null;
/** the last k raw per-block estimates at/below h with enough samples (UTXOracle median input) */
export const recentOracleRaw = (db: Db, h: number, k: number): number[] =>
  (db.prepare("SELECT price_usd FROM oracle WHERE height<=? AND samples>=100 ORDER BY height DESC LIMIT ?").all(h, k) as { price_usd: string }[]).map((r) => Number(r.price_usd));

/* ── owners (not consensus: shown by the API) ───────────────────────────────────────────────────────────────────────── */
export const getCovenantOwner = (db: Db, cov: string): string | null => (db.prepare("SELECT wallet_address FROM covenant_owners WHERE covenant_address=?").get(cov) as { wallet_address: string } | undefined)?.wallet_address ?? null;
export const setCovenantOwner = (db: Db, cov: string, wallet: string, xonly: string, source: string) =>
  db.prepare("INSERT OR IGNORE INTO covenant_owners(covenant_address,wallet_address,owner_xonly,source) VALUES(?,?,?,?)").run(cov, wallet, xonly, source);

/* ── reorg: undo everything at height >= fork (the reference rewindTo, unchanged in effect) ─────────────────────────── */
export function rewindTo(db: Db, fork: number) {
  tx(db, () => {
    for (const r of bigRead(db.prepare("SELECT op, SUM(CAST(atoms AS INTEGER)) s FROM deltas WHERE height >= ? AND (op LIKE 'burn:%' OR op LIKE 'raise:%') GROUP BY op")).all(fork) as { op: string; s: bigint | null }[]) {
      const [kind, tick] = r.op.split(":") as [string, string];
      const key = kind === "burn" ? `burned_atoms:${tick}` : `raise:${tick}`;
      const next = BigInt(getMeta(db, key, "0")!) - BigInt(r.s ?? 0);
      setMeta(db, key, next < 0n ? 0n : next);
    }
    db.prepare("DELETE FROM seals WHERE height >= ?").run(fork);
    db.prepare("UPDATE seals SET status='active', spent_txid=NULL WHERE spent_txid IN (SELECT txid FROM deltas WHERE height >= ?)").run(fork);
    for (const t of ["deltas", "blocks", "oracle", "deploy", "bons_fills", "pob_used", "other_deploys", "launch_refunds", "launch_payments"])
      db.prepare(`DELETE FROM ${t} WHERE height >= ?`).run(fork);
    db.prepare("DELETE FROM balances").run();
    for (const s of db.prepare("SELECT tick, owner_address, amount_atoms FROM seals WHERE status='active'").all() as unknown as Seal[]) credit(db, s.owner_address, BigInt(s.amount_atoms), s.tick);
    const minted: Record<string, bigint> = {}, opening: Record<string, bigint> = {};
    for (const s of db.prepare("SELECT tick, amount_atoms, bucket FROM seals WHERE kind='allocation' AND status != 'voided'").all() as unknown as Seal[]) {
      minted[s.tick] = (minted[s.tick] ?? 0n) + BigInt(s.amount_atoms);
      if (s.bucket === "opening") opening[s.tick] = (opening[s.tick] ?? 0n) + BigInt(s.amount_atoms);
    }
    for (const [t, a] of Object.entries(minted)) setMeta(db, `minted_atoms:${t}`, a);
    for (const [t, a] of Object.entries(opening)) setMeta(db, `opening_minted_atoms:${t}`, a);
    setCursor(db, fork);
  });
}

/* ── typed query helpers ────────────────────────────────────────────────────────────────────────────────────────────── */
type Param = string | number | bigint | null;
export const all = <T>(db: Db, sql: string, ...a: Param[]): T[] => db.prepare(sql).all(...a) as unknown as T[];
export const one = <T>(db: Db, sql: string, ...a: Param[]): T | undefined => db.prepare(sql).get(...a) as unknown as T | undefined;
export const run = (db: Db, sql: string, ...a: Param[]) => db.prepare(sql).run(...a);
