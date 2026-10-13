// A stand-in for Bitcoin Core's JSON-RPC, serving a recorded chain: just enough of the interface the indexer uses
// (getnetworkinfo, getblockcount, getblockhash, getblockheader, getblock 0|3, getrawtransaction 2, batches).
// `setTip(h)` shortens the chain and `replaceFrom(h, blocks)` swaps in a fork, to test reorgs.
import http from "node:http";
import * as bitcoin from "bitcoinjs-lib";

const CORE_TYPE = (s) =>
  s[0] === 0x6a ? "nulldata"
  : s.length === 34 && s[0] === 0x51 && s[1] === 0x20 ? "witness_v1_taproot"
  : s.length === 22 && s[0] === 0x00 && s[1] === 0x14 ? "witness_v0_keyhash"
  : s.length === 34 && s[0] === 0x00 && s[1] === 0x20 ? "witness_v0_scripthash"
  : s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 ? "pubkeyhash"
  : s.length === 23 && s[0] === 0xa9 ? "scripthash"
  : "nonstandard";

export function startMockNode(blocksHex, network = bitcoin.networks.regtest) {
  let chain = [];            // [{ hash, height, prev, time, hex, txs: bitcoin.Transaction[] }]
  const outputs = new Map(); // "txid:vout" -> { value, script }
  const txIndex = new Map(); // txid -> { tx, blockHash }
  const load = (hexes, from) => {
    chain = chain.slice(0, from);
    for (const hex of hexes) {
      const b = bitcoin.Block.fromHex(hex), hash = b.getId();
      const prev = Buffer.from(b.prevHash).reverse().toString("hex");
      chain.push({ hash, height: chain.length, prev: chain.length ? prev : null, time: b.timestamp, hex, txs: b.transactions });
      for (const t of b.transactions) {
        const id = t.getId(); txIndex.set(id, { tx: t, blockHash: hash });
        t.outs.forEach((o, n) => outputs.set(`${id}:${n}`, { value: Number(o.value), script: Buffer.from(o.script) }));
      }
    }
  };
  load(blocksHex, 0);
  let tip = chain.length - 1;

  const spk = (script) => {
    let address; try { address = bitcoin.address.fromOutputScript(script, network); } catch { /* none */ }
    return { hex: script.toString("hex"), type: CORE_TYPE(script), ...(address ? { address } : {}) };
  };
  const coreTx = (t) => {
    const coinbase = t.isCoinbase();
    return {
      txid: t.getId(),
      vin: t.ins.map((i) => {
        const w = (i.witness ?? []).map((x) => Buffer.from(x).toString("hex"));
        if (coinbase) return { coinbase: Buffer.from(i.script).toString("hex"), txinwitness: w, sequence: i.sequence };
        const txid = Buffer.from(i.hash).reverse().toString("hex"), p = outputs.get(`${txid}:${i.index}`);
        return { txid, vout: i.index, txinwitness: w, sequence: i.sequence, ...(p ? { prevout: { value: p.value / 1e8, scriptPubKey: spk(p.script) } } : {}) };
      }),
      vout: t.outs.map((o, n) => ({ value: Number(o.value) / 1e8, n, scriptPubKey: spk(Buffer.from(o.script)) })),
    };
  };
  const byHash = (h) => chain.slice(0, tip + 1).find((b) => b.hash === h);
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const methods = {
    getnetworkinfo: () => ({ version: 300000, subversion: "/mock:30.0.0/" }),
    getblockcount: () => tip,
    getblockhash: ([h]) => (h >= 0 && h <= tip ? chain[h].hash : fail(-8, "Block height out of range")),
    getblockheader: ([h]) => { const b = byHash(h) ?? fail(-5, "Block not found"); return { hash: b.hash, height: b.height, previousblockhash: b.prev ?? undefined, time: b.time }; },
    getblock: ([h, v]) => {
      const b = byHash(h) ?? fail(-5, "Block not found");
      if (v === 0) return b.hex;
      return { hash: b.hash, height: b.height, previousblockhash: b.prev ?? undefined, time: b.time, tx: b.txs.map(coreTx) };
    },
    getrawtransaction: ([id]) => { const t = txIndex.get(id) ?? fail(-5, "No such transaction"); return coreTx(t.tx); },
    getrawmempool: () => [],
  };
  const answer = (q) => { try { return { id: q.id, result: methods[q.method] ? methods[q.method](q.params ?? []) : fail(-32601, "Method not found"), error: null }; }
    catch (e) { return { id: q.id, result: null, error: { code: e.code ?? -1, message: e.message } }; } };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => { const q = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(answer) : answer(q))); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    tipHeight: () => tip,
    setTip: (h) => { tip = h; },
    replaceFrom: (h, hexes) => { load(hexes, h); tip = chain.length - 1; },
    close: () => new Promise((r) => server.close(r)),
  })));
}
