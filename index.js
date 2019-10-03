const pkg = require('./package.json');
const { send } = require('micro')
const url = require('url')
const { Exporter } = require('san-exporter')
const rp = require('request-promise-native')
const uuidv1 = require('uuid/v1')
const metrics = require('./src/metrics')

const exporter = new Exporter(pkg.name)

const SEND_BATCH_SIZE = parseInt(process.env.SEND_BATCH_SIZE || "10")
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || "10000")
const NODE_URL = process.env.NODE_URL || 'http://litecoind.default.svc.cluster.local:9332'
const RPC_USERNAME = process.env.RPC_USERNAME || 'rpcuser'
const RPC_PASSWORD = process.env.RPC_PASSWORD || 'rpcpassword'

const request = rp.defaults({
  method: 'POST',
  uri: NODE_URL,
  auth: {
    user: RPC_USERNAME,
    pass: RPC_PASSWORD
  },
  timeout: DEFAULT_TIMEOUT,
  time: true,
  gzip: true,
  json: true
})

let lastProcessed = {
  blockNumber: parseInt(process.env.BLOCK || "1"), //TODO Shoul it be "0"
}

const sendRequest = (async (method, params) => {
  metrics.requestsCounter.inc()

  const startTime = new Date()
  return request({
    body: {
      jsonrpc: '1.0',
      id: uuidv1(),
      method: method,
      params: params
    }
  }).then(({ result, error }) => {
    metrics.requestsResponseTime.observe(new Date() - startTime)

    if(error) {
      return Promise.reject(error)
    }

    return result
  })
})

const fetchBlockHashByIndex = async (blockIndex) => {
  return await sendRequest('getblockhash', [blockIndex])
}

const fetchBlockByHash = async (blockHash) => {
  return await sendRequest('getblock', [blockHash, 2])
}

const fetchBlockByIndex = async (blockIndex) => {
  let blockHash = await fetchBlockHashByIndex(blockIndex)
  return await fetchBlockByHash(blockHash)
}

async function rollbackOrphans() {
  let blocks = []
  let lastProcessedHash = lastProcessed.blockHash
  let lastExportedBlock = await fetchBlockByHash(lastProcessedHash);

  while (lastExportedBlock.confirmations === -1) {
    blocks.unshift(lastExportedBlock)
    lastProcessedHash = lastExportedBlock.previousblockhash
    lastExportedBlock = await fetchBlockByHash(lastProcessedHash);
  }
  if(blocks.length) {

    // TODO find if we need to decrement this counter
    // TODO in that case it would be better to change to Gauge

    // const blocks = await Promise.all(blocks).map(async (block) => {
    //   metrics.downloadedTransactionsCounter.dec(block.nTx)
    //   metrics.downloadedBlocksCounter.dec()

    //   return block
    // })

    console.info(`Rollback blocks ${blocks[0].height}:${blocks[blocks.length - 1].height}`)
    await exporter.sendDataWithKey(blocks, "height")

    lastProcessed.blockNumber -= blocks.length
    lastProcessed.blockHash = lastProcessedHash
    await saveNewPosition()
  }
}


async function saveNewPosition()  {
  await exporter.savePosition(lastProcessed)
  metrics.lastExportedBlock.set(lastProcessed.blockNumber)
}


async function work() {
  await rollbackOrphans()

  const blockchainInfo = await sendRequest('getblockchaininfo', [])
  const currentBlock = blockchainInfo.blocks

  metrics.currentBlock.set(currentBlock)

  const requests = []

  while (lastProcessed.blockNumber + requests.length <= currentBlock) {
    const blockToDownload = lastProcessed.blockNumber + requests.length
    console.info(`block to download ${blockToDownload}`)

    requests.push(fetchBlockByIndex(blockToDownload))

    if (requests.length >= SEND_BATCH_SIZE || blockToDownload == currentBlock) {
      const blocks = await Promise.all(requests).map(async (block) => {
        metrics.downloadedTransactionsCounter.inc(block.nTx)
        metrics.downloadedBlocksCounter.inc()

        return block
      })

      console.info(`Flushing blocks ${blocks[0].height}:${blocks[blocks.length - 1].height}`)
      await exporter.sendDataWithKey(blocks, "height")

      lastProcessed.blockNumber += blocks.length
      lastProcessed.blockHash = blocks[blocks.length - 1].hash
      await exporter.savePosition(lastProcessed)
      metrics.lastExportedBlock.set(lastProcessed.blockNumber)

      requests.length = 0
    }
  }
}

async function initLastProcessedLedger() {
  const lastPosition = await exporter.getLastPosition()

  if (lastPosition) {
    lastProcessed = lastPosition
  }
  if (!lastProcessed.blockHash) {
    lastProcessed.blockHash = await fetchBlockHashByIndex(
      lastProcessed.blockNumber
    )
  }

  if (lastPosition) {
    console.info(`Resuming export from position ${JSON.stringify(lastProcessed)}`)
  } else {
    await exporter.savePosition(lastProcessed)
    console.info(`Initialized exporter with initial position ${JSON.stringify(lastProcessed)}`)
  }
}

const fetchEvents = () => {
  return work()
    .then(() => {
      // Look for new events every 1 sec
      setTimeout(fetchEvents, 1000)
    })
}

const init = async () => {
  metrics.startCollection()
  await exporter.connect()
  await initLastProcessedLedger()
  await fetchEvents()
}

init()

const healthcheckKafka = () => {
  return new Promise((resolve, reject) => {
    if (exporter.producer.isConnected()) {
      resolve()
    } else {
      reject("Kafka client is not connected to any brokers")
    }
  })
}

module.exports = async (request, response) => {
  const req = url.parse(request.url, true);

  switch (req.pathname) {
    case '/healthcheck':
      return healthcheckKafka()
        .then(() => send(response, 200, "ok"))
        .catch((err) => send(response, 500, `Connection to kafka failed: ${err}`))

    case '/metrics':
      response.setHeader('Content-Type', metrics.register.contentType);
      return send(response, 200, metrics.register.metrics())

    default:
      return send(response, 404, 'Not found');
  }
}
