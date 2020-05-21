const pkg = require('./package.json');
const { send } = require('micro')
const url = require('url')
const { Exporter } = require('@santiment-network/san-exporter')
const rp = require('request-promise-native')
const uuidv1 = require('uuid/v1')
const metrics = require('./src/metrics')

const exporter = new Exporter(pkg.name)

const SEND_BATCH_SIZE = parseInt(process.env.SEND_BATCH_SIZE || "10")
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || "10000")
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "3")
const NODE_URL = process.env.NODE_URL || 'http://litecoind.default.svc.cluster.local:9332'
const RPC_USERNAME = process.env.RPC_USERNAME || 'rpcuser'
const RPC_PASSWORD = process.env.RPC_PASSWORD || 'rpcpassword'
const EXPORT_TIMEOUT_MLS = parseInt(process.env.EXPORT_TIMEOUT_MLS || 1000 * 60 * 15)     // 15 minutes

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

// To prevent healthcheck failing during initialization and processing first part of data,
// we set lastExportTime to current time.
let lastExportTime = Date.now()

let lastProcessedPosition = {
  blockNumber: parseInt(process.env.BLOCK || "1"),
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

    if (error) {
      return Promise.reject(error)
    }

    return result
  })
})

const fetchBlock = async (block_index) => {
  let blockHash = await sendRequest('getblockhash', [block_index])
  return await sendRequest('getblock', [blockHash, 2])
}

async function work() {
  const blockchainInfo = await sendRequest('getblockchaininfo', [])
  const currentBlock = blockchainInfo.blocks - CONFIRMATIONS

  metrics.currentBlock.set(currentBlock)

  const requests = []

  while (lastProcessedPosition.blockNumber + requests.length <= currentBlock) {
    const blockToDownload = lastProcessedPosition.blockNumber + requests.length

    requests.push(fetchBlock(blockToDownload))

    if (requests.length >= SEND_BATCH_SIZE || blockToDownload == currentBlock) {
      const blocks = await Promise.all(requests).map(async (block) => {
        metrics.downloadedTransactionsCounter.inc(block.tx.length)
        metrics.downloadedBlocksCounter.inc()

        return block
      })

      console.log(`Flushing blocks ${blocks[0].height}:${blocks[blocks.length - 1].height}`)
      await exporter.sendDataWithKey(blocks, "height")

      lastExportTime = Date.now()
      lastProcessedPosition.blockNumber += blocks.length
      await exporter.savePosition(lastProcessedPosition)
      metrics.lastExportedBlock.set(lastProcessedPosition.blockNumber)

      requests.length = 0
    }
  }
}

async function initLastProcessedLedger() {
  const lastPosition = await exporter.getLastPosition()

  if (lastPosition) {
    lastProcessedPosition = lastPosition
    console.info(`Resuming export from position ${JSON.stringify(lastPosition)}`)
  } else {
    await exporter.savePosition(lastProcessedPosition)
    console.info(`Initialized exporter with initial position ${JSON.stringify(lastProcessedPosition)}`)
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
  if (exporter.producer.isConnected()) {
      return Promise.resolve()
  } else {
      return Promise.reject("Kafka client is not connected to any brokers")
  }
}

const healthcheckExportTimeout = () => {
    const timeFromLastExport = Date.now() - lastExportTime
    const isExportTimeoutExceeded = timeFromLastExport > EXPORT_TIMEOUT_MLS
    if (isExportTimeoutExceeded) {
        const msg = `Time from the last export ${timeFromLastExport}ms exceeded limit  ${EXPORT_TIMEOUT_MLS}ms.`
        return Promise.reject(msg)
    } else {
        return Promise.resolve()
    }
}

module.exports = async (request, response) => {
  const req = url.parse(request.url, true);

  switch (req.pathname) {
    case '/healthcheck':
    return healthcheckKafka()
        .then(() => healthcheckExportTimeout())
        .then(() => send(response, 200, "ok"))
        .catch((err) => send(response, 500, err.toString()))

    case '/metrics':
      response.setHeader('Content-Type', metrics.register.contentType);
      return send(response, 200, metrics.register.metrics())

    default:
      return send(response, 404, 'Not found');
  }
}
