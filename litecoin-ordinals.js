import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';
import fetch from 'node-fetch';

// Litecoin network parameters
export const LITECOIN = {
  bech32: 'ltc',
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
  bip32: {
    public: 0x019da462, // Ltub
    private: 0x019d9cfe, // Ltpv
  },
};

export const LITECOIN_TESTNET = {
  bech32: 'tltc',
  pubKeyHash: 0x6f,
  scriptHash: 0x3a,
  wif: 0xef,
  bip32: {
    public: 0x043587cf, // tpub
    private: 0x04358394, // tprv
  },
};

function toSats(amountLtc) {
  if (typeof amountLtc === 'bigint') return amountLtc;
  if (typeof amountLtc === 'number') return BigInt(Math.round(amountLtc * 1e8));
  if (typeof amountLtc === 'string') return BigInt(Math.round(parseFloat(amountLtc) * 1e8));
  throw new Error('Unsupported amount type');
}

export function chunkData(data, size = 520) {
  const chunks = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size));
  return chunks;
}

export function rpc(url, user, pass) {
  return async function rpcCall(method, params = []) {
    const body = { jsonrpc: '1.0', id: 'ltc', method, params };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || String(json.error));
    return json.result;
  };
}

export function buildRevealPayment(pubKey, inscriptions, network = LITECOIN) {
  const customScripts = [ordinals.OutOrdinalReveal];
  return btc.p2tr(
    undefined,
    ordinals.p2tr_ord_reveal(pubKey, inscriptions),
    network,
    false,
    customScripts
  );
}

export async function createRevealTx({
  rpcCall,
  revealPayment,
  privKey,
  feeSats,
  changeAddress,
  network = LITECOIN,
}) {
  const customScripts = [ordinals.OutOrdinalReveal];
  const tx = new btc.Transaction({ customScripts });

  // Funded UTXO must already exist at revealPayment.address
  const utxos = await rpcCall('listunspent', [0, 9999999, [revealPayment.address]]);
  if (!utxos || !utxos.length) throw new Error('No UTXOs at reveal address');

  // Take first UTXO for simplicity
  const u = utxos[0];
  const amount = BigInt(Math.round(u.amount * 1e8));
  const input = {
    ...revealPayment,
    txid: u.txid,
    index: u.vout,
    witnessUtxo: { script: revealPayment.script, amount },
  };
  tx.addInput(input);

  const change = (amount - BigInt(feeSats));
  if (change <= 0n) throw new Error('Insufficient funds for fee');
  const outAddr = changeAddress || revealPayment.address;
  tx.addOutputAddress(outAddr, change, network);

  tx.sign(privKey, undefined, new Uint8Array(32));
  tx.finalize();
  return tx;
}

export function parseInscriptionsFromTxHex(txHex) {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex));
  for (const input of tx.inputs) {
    if (input.finalScriptWitness) {
      const parsed = ordinals.parseWitness(input.finalScriptWitness);
      if (parsed && parsed.length) return parsed;
    }
  }
  return [];
}

export async function demo() {
  const PRIV_HEX = process.env.PRIV_HEX || '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
  const RPC_URL = process.env.LTC_RPC_URL || 'http://127.0.0.1:9332';
  const RPC_USER = process.env.LTC_RPC_USER || 'user';
  const RPC_PASS = process.env.LTC_RPC_PASS || 'pass';

  const rpcCall = rpc(RPC_URL, RPC_USER, RPC_PASS);
  const privKey = hex.decode(PRIV_HEX);
  const pubKey = btc.utils.pubSchnorr(privKey);

  const inscription = {
    tags: { contentType: 'text/plain;charset=utf-8' },
    body: utf8.decode('Hello, Litecoin Ordinals!'),
  };

  const revealPayment = buildRevealPayment(pubKey, [inscription], LITECOIN);
  console.log('Commit (fund this) address:', revealPayment.address);

  // Wait for manual funding of revealPayment.address with enough LTC.
  // Then construct and broadcast reveal transaction.
  const tx = await createRevealTx({
    rpcCall,
    revealPayment,
    privKey,
    feeSats: 1000n,
    changeAddress: revealPayment.address,
    network: LITECOIN,
  });

  const txHex = hex.encode(tx.extract());
  const txid = await rpcCall('sendrawtransaction', [txHex]);
  console.log('Reveal TXID:', txid);

  // Parse back
  const raw = await rpcCall('getrawtransaction', [txid]);
  const parsed = parseInscriptionsFromTxHex(raw);
  console.log('Parsed inscriptions:', parsed.map((p) => ({ tags: p.tags, bodyLen: p.body.length })));
}

if (process.env.RUN_DEMO === '1') {
  demo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}