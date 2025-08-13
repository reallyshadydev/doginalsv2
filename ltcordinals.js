#!/usr/bin/env node

const axios = require('axios')
const fs = require('fs')
const dotenv = require('dotenv')
const express = require('express')

// Use Litecoin bitcore-lib for Script/Opcode parsing
const litecore = require('bitcore-lib-ltc')
const { Script, Opcode } = litecore

dotenv.config()

const WALLET_PATH = process.env.WALLET || '.wallet.json'

async function main() {
  const cmd = process.argv[2]

  if (cmd === 'server') {
    await server()
  } else if (cmd === 'extract') {
    const txid = process.argv[3]
    if (!txid) throw new Error('usage: ltcordinals extract <txid>')
    const result = await extractLitecoinOrdinal(txid)
    process.stdout.write(result.data)
  } else if (cmd === 'wallet' && process.argv[3] === 'sync') {
    await walletSyncLitecoin()
  } else {
    throw new Error(`unknown command: ${cmd}`)
  }
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