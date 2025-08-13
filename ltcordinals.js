#!/usr/bin/env node

const axios = require('axios')
const fs = require('fs')
const dotenv = require('dotenv')
const express = require('express')
const crypto = require('crypto')

// Use Litecoin bitcore-lib for Script/Opcode parsing
const litecore = require('bitcore-lib-ltc')
const { Script, Opcode } = litecore

// BitcoinJS for Taproot construction (to be used for mint implementation)
const ecc = require('tiny-secp256k1')
const bitcoinjs = require('bitcoinjs-lib')
bitcoinjs.initEccLib(ecc)
const { networks, payments, script: bscript, opcodes } = bitcoinjs

dotenv.config()

const WALLET_PATH = process.env.WALLET || '.wallet.json'

function getLitecoinNetwork() {
  const isTestnet = process.env.TESTNET === 'true'
  return isTestnet
    ? { bech32: 'tltc', pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef } // testnet-like
    : { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
}

async function main() {
  const cmd = process.argv[2]

  if (cmd === 'server') {
    await server()
  } else if (cmd === 'extract') {
    const txid = process.argv[3]
    if (!txid) throw new Error('usage: ltcordinals extract <txid>')
    const result = await extractLitecoinOrdinal(txid)
    process.stdout.write(result.data)
  } else if (cmd === 'wallet') {
    const sub = process.argv[3]
    if (sub === 'sync') {
      await walletSyncLitecoin()
    } else if (sub === 'new') {
      walletNewLitecoin()
    } else {
      throw new Error('usage: ltcordinals wallet <new|sync>')
    }
  } else if (cmd === 'mint') {
    await mintLitecoin()
  } else {
    throw new Error(`unknown command: ${cmd}`)
  }
}

function walletNewLitecoin() {
  if (fs.existsSync(WALLET_PATH)) throw new Error('wallet already exists')
  const privkey = crypto.randomBytes(32)
  const pubkey = Buffer.from(ecc.pointFromScalar(privkey, true))
  const network = getLitecoinNetwork()
  const p2wpkh = payments.p2wpkh({ pubkey, network })
  const json = { privkey: privkey.toString('hex'), address: p2wpkh.address, utxos: [] }
  fs.writeFileSync(WALLET_PATH, JSON.stringify(json, null, 2))
  console.log('ltc bech32 address', p2wpkh.address)
}

async function walletSyncLitecoin() {
  if (!fs.existsSync(WALLET_PATH)) throw new Error('wallet file not found')
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

  const body = {
    jsonrpc: '1.0',
    id: 'walletsync',
    method: 'listunspent',
    params: [0, 9999999, [wallet.address]]
  }
  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS
    }
  }

  const response = await axios.post(process.env.NODE_RPC_URL, body, options)
  const utxos = response.data.result || []

  wallet.utxos = utxos.map(utxo => ({
    txid: utxo.txid,
    vout: utxo.vout,
    script: utxo.scriptPubKey,
    satoshis: Math.round(utxo.amount * 1e8)
  }))

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2))
  const balance = wallet.utxos.reduce((acc, u) => acc + u.satoshis, 0)
  console.log('balance', balance)
}

function chunkToNumber(chunk) {
  if (!chunk) return undefined
  if (chunk.opcodenum === 0) return 0
  if (chunk.opcodenum === 1) return chunk.buf[0]
  if (chunk.opcodenum === 2) return chunk.buf[1] * 255 + chunk.buf[0]
  if (chunk.opcodenum > 80 && chunk.opcodenum <= 96) return chunk.opcodenum - 80
  return undefined
}

function findOrdinalInTapscript(tapscriptBuffer) {
  const script = Script.fromBuffer(tapscriptBuffer)
  const chunks = [...script.chunks]

  // Expect standard Ordinals envelope: OP_FALSE OP_IF "ord" 01 <content-type> 00 <data> OP_ENDIF
  if (!chunks.length) return null
  const first = chunks.shift()
  const second = chunks.shift()
  if (!first || !second) return null
  if (!(first.opcodenum === Opcode.OP_FALSE && second.opcodenum === Opcode.OP_IF)) return null

  const tag = chunks.shift()
  if (!tag || !tag.buf || tag.buf.toString('utf-8') !== 'ord') return null

  const ctMarker = chunkToNumber(chunks.shift())
  if (ctMarker !== 1) return null

  const ctChunk = chunks.shift()
  if (!ctChunk || !ctChunk.buf) return null
  const contentType = ctChunk.buf.toString('utf-8')

  const dataMarker = chunkToNumber(chunks.shift())
  if (dataMarker !== 0) return null

  const dataChunk = chunks.shift()
  if (!dataChunk || !dataChunk.buf) return null

  return { contentType, data: Buffer.from(dataChunk.buf) }
}

async function extractLitecoinOrdinal(txid) {
  const body = {
    jsonrpc: '1.0',
    id: 'extract',
    method: 'getrawtransaction',
    params: [txid, true]
  }
  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS
    }
  }

  const response = await axios.post(process.env.NODE_RPC_URL, body, options)
  const tx = response.data.result
  if (!tx) throw new Error('transaction not found')

  // Search all inputs for a tapscript witness containing the ord envelope
  for (const vin of tx.vin || []) {
    const wit = vin.txinwitness
    if (!Array.isArray(wit) || wit.length < 2) continue
    // tapscript path spend: [...stack], tapscript, controlblock
    const tapscriptHex = wit[wit.length - 2]
    if (!tapscriptHex) continue
    const tapscriptBuffer = Buffer.from(tapscriptHex, 'hex')
    const found = findOrdinalInTapscript(tapscriptBuffer)
    if (found) return found
  }

  throw new Error('no litecoin ordinal inscription found in witness')
}

async function mintLitecoin() {
  const receiverAddress = process.argv[3]
  const contentTypeOrFilename = process.argv[4]
  const hexData = process.argv[5]

  if (!receiverAddress || !contentTypeOrFilename) {
    throw new Error('usage: ltcordinals mint <receiverAddress> <content-type|filepath> [hexdata]')
  }

  let contentType, data
  if (fs.existsSync(contentTypeOrFilename)) {
    const mime = require('mime-types')
    contentType = mime.contentType(mime.lookup(contentTypeOrFilename))
    data = fs.readFileSync(contentTypeOrFilename)
  } else {
    contentType = contentTypeOrFilename
    if (!/^[a-fA-F0-9]*$/.test(hexData || '')) throw new Error('data must be hex')
    data = Buffer.from(hexData || '', 'hex')
  }

  if (!contentType || data.length === 0) throw new Error('no data to mint')
  if (!fs.existsSync(WALLET_PATH)) throw new Error('wallet not found, run: ltcordinals wallet new')
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
  const feeRate = getFeeRateSatVb()

  const privkey = Buffer.from(wallet.privkey, 'hex')
  const pubkey = Buffer.from(ecc.pointFromScalar(privkey, true)) // 33 bytes
  const xOnlyPubkey = pubkey.slice(1, 33) // 32 bytes
  const network = getLitecoinNetwork()

  // Build inscription tapscript: OP_FALSE OP_IF "ord" 01 <content-type> 00 <data> OP_ENDIF <xonly-pubkey> OP_CHECKSIG
  const inscriptionScript = bscript.compile([
    opcodes.OP_FALSE,
    opcodes.OP_IF,
    Buffer.from('ord'),
    1,
    Buffer.from(contentType),
    0,
    data,
    opcodes.OP_ENDIF,
    xOnlyPubkey,
    opcodes.OP_CHECKSIG,
  ])

  // Create P2TR address committing to our leaf
  const p2tr = payments.p2tr({ internalPubkey: xOnlyPubkey, scriptTree: { output: inscriptionScript }, network })
  if (!p2tr.output || !p2tr.address) throw new Error('failed to build p2tr output')

  // Select a single UTXO to fund commit tx
  const utxo = selectSingleUtxo(wallet.utxos)
  if (!utxo) throw new Error('no funds to mint')

  // Estimate commit fee (1 P2WPKH in, 1 P2TR out)
  const commitVBytes = 190
  const commitFee = Math.max(500, Math.floor(commitVBytes * feeRate))

  const inputValue = utxo.satoshis
  if (inputValue <= commitFee + 1000) throw new Error('selected utxo too small')

  const commitOutputValue = inputValue - commitFee // no change for simplicity

  // Build commit PSBT
  const commitPsbt = new bitcoinjs.Psbt({ network })
  commitPsbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: { script: Buffer.from(utxo.script, 'hex'), value: inputValue },
    tapInternalKey: undefined,
  })
  commitPsbt.addOutput({ address: p2tr.address, value: commitOutputValue })

  const ecdsaSigner = makeDualSigner(privkey, pubkey)
  commitPsbt.signAllInputs(ecdsaSigner)
  commitPsbt.finalizeAllInputs()
  const commitTx = commitPsbt.extractTransaction()

  await rpcBroadcast(commitTx.toHex())

  // Build control block for reveal
  const leafVersion = 0xc0
  const controlBlock = buildControlBlock(xOnlyPubkey, inscriptionScript, leafVersion)

  // Estimate reveal fee (1 P2TR in script path, 1 P2WPKH/P2TR out)
  const revealVBytes = 180 + Math.ceil(inscriptionScript.length / 4) // rough, script is counted in witness
  const revealFee = Math.max(500, Math.floor(revealVBytes * feeRate))
  if (commitOutputValue <= revealFee + 600) throw new Error('commit output too small for reveal')

  const revealOutputValue = commitOutputValue - revealFee

  // Build reveal PSBT spending the commit output via script path
  const revealPsbt = new bitcoinjs.Psbt({ network })
  revealPsbt.addInput({
    hash: commitTx.getId(),
    index: 0,
    witnessUtxo: { script: p2tr.output, value: commitOutputValue },
    tapLeafScript: [
      {
        leafVersion,
        script: inscriptionScript,
        controlBlock,
      },
    ],
  })
  revealPsbt.addOutput({ address: receiverAddress, value: revealOutputValue })

  const schnorrSigner = makeDualSigner(privkey, pubkey) // supports schnorr
  revealPsbt.signAllInputs(schnorrSigner)
  revealPsbt.finalizeAllInputs()
  const revealTx = revealPsbt.extractTransaction()

  await rpcBroadcast(revealTx.toHex())
  console.log('broadcasted commit:', commitTx.getId())
  console.log('broadcasted reveal:', revealTx.getId())
}

function getFeeRateSatVb() {
  const env = process.env.LTC_FEE_RATE_SAT_VB || process.env.FEE_RATE_SAT_VB
  const n = env ? parseFloat(env) : 5
  return isFinite(n) && n > 0 ? n : 5
}

function selectSingleUtxo(utxos) {
  if (!Array.isArray(utxos) || utxos.length === 0) return null
  // Prefer largest to cover fees comfortably
  const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis)
  return sorted[0]
}

function makeDualSigner(privkey, pubkey) {
  return {
    publicKey: pubkey,
    sign: (hash) => ecc.sign(hash, privkey), // ECDSA for P2WPKH
    signSchnorr: (hash) => ecc.signSchnorr(hash, privkey), // Schnorr for Tapscript
  }
}

function taggedHash(tag, ...msgs) {
  const tagHash = bitcoinjs.crypto.sha256(Buffer.from(tag))
  return bitcoinjs.crypto.sha256(Buffer.concat([tagHash, tagHash, ...msgs]))
}

function tapLeafHash(leafVersion, script) {
  return taggedHash('TapLeaf', Buffer.from([leafVersion]), bitcoinjs.script.toBuffer(script))
}

function tapTweakHash(xOnlyInternalPubkey, merkleRoot) {
  if (merkleRoot) return taggedHash('TapTweak', xOnlyInternalPubkey, merkleRoot)
  return taggedHash('TapTweak', xOnlyInternalPubkey)
}

function buildControlBlock(xOnlyInternalPubkey, script, leafVersion) {
  const leafHash = tapLeafHash(leafVersion, script)
  const tweak = tapTweakHash(xOnlyInternalPubkey, leafHash)
  const internalCompressed = Buffer.concat([Buffer.from([0x02]), xOnlyInternalPubkey])
  const outputKey = ecc.pointAddScalar(internalCompressed, tweak)
  if (!outputKey) throw new Error('failed to compute tweaked output key')
  const parity = outputKey[0] === 0x03 ? 1 : 0
  const ctrlByte = Buffer.from([leafVersion | parity])
  return Buffer.concat([ctrlByte, xOnlyInternalPubkey])
}

async function rpcBroadcast(rawtx) {
  const body = { jsonrpc: '1.0', id: 'send', method: 'sendrawtransaction', params: [rawtx] }
  const options = { auth: { username: process.env.NODE_RPC_USER, password: process.env.NODE_RPC_PASS } }
  const resp = await axios.post(process.env.NODE_RPC_URL, body, options)
  return resp.data.result
}

function server() {
  const app = express()
  const port = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 3001

  app.get('/tx/:txid', (req, res) => {
    extractLitecoinOrdinal(req.params.txid)
      .then(result => {
        res.setHeader('content-type', result.contentType)
        res.send(result.data)
      })
      .catch(e => res.status(404).send(e.message))
  })

  app.listen(port, () => {
    console.log(`Litecoin Ordinals viewer listening on port ${port}`)
    console.log(`Example: http://localhost:${port}/tx/<ltc-txid>`)
  })
}

main().catch(e => {
  const reason = e.response && e.response.data && e.response.data.error && e.response.data.error.message
  console.error(reason ? e.message + ':' + reason : e.message)
})