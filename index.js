const pkg = require('./package.json');
const { send } = require('micro')
const url = require('url')
const { Exporter } = require('san-exporter')
const metrics = require('san-exporter/metrics')
const rp = require('request-promise-native')
const uuidv1 = require('uuid/v1')
const { logger } = require('./logger')

const exporter = new Exporter(pkg.name)

const SEND_BATCH_SIZE = parseInt(process.env.SEND_BATCH_SIZE || "10")
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || "10000")
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "3")
const NODE_URL = process.env.NODE_URL || 'http://litecoin.stage.san:30992'
const RPC_USERNAME = process.env.RPC_USERNAME || 'rpcuser'
const RPC_PASSWORD = process.env.RPC_PASSWORD || 'rpcpassword'
const EXPORT_TIMEOUT_MLS = parseInt(process.env.EXPORT_TIMEOUT_MLS || 1000 * 60 * 30)     // 30 minutes
const DOGE = parseInt(process.env.DOGE || "0")
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS || "10")

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

let currentNodeBlock = 0

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

const getDogeTransactionData = async (transaction_hashes) => {
  listPromises = []
  decodedTransactions = []
  for (const transaction_hash of transaction_hashes) {
    let promise = sendRequest('getrawtransaction', [transaction_hash]).then(value => {
      return sendRequest('decoderawtransaction', [value]).then(decodedTransaction => {
        return decodedTransaction
      })
    })
    listPromises.push(promise)
    if (listPromises.length >= MAX_CONCURRENT_REQUESTS) {
      let newDecodedTransactions = await Promise.all(listPromises)
      listPromises = []
      decodedTransactions = decodedTransactions.concat(newDecodedTransactions)
    }
  }
  newDecodedTransactions = await Promise.all(listPromises);
  decodedTransactions = decodedTransactions.concat(newDecodedTransactions)
  return decodedTransactions
}

const fetchBlock = async (block_index) => {
  let blockHash = await sendRequest('getblockhash', [block_index])
  if (DOGE) {
    let blockData = await sendRequest('getblock', [blockHash, true])
    let transactionData = await getDogeTransactionData(blockData.tx)
    blockData["tx"] = transactionData
    return blockData
  }
  return await sendRequest('getblock', [blockHash, 2])
}

async function work() {
  const blockchainInfo = await sendRequest('getblockchaininfo', [])
  currentNodeBlock = blockchainInfo.blocks - CONFIRMATIONS

  metrics.currentBlock.set(currentNodeBlock)

  const requests = []

  while (lastProcessedPosition.blockNumber + requests.length <= currentNodeBlock) {
    const blockToDownload = lastProcessedPosition.blockNumber + requests.length

    requests.push(fetchBlock(blockToDownload))

    if (requests.length >= SEND_BATCH_SIZE || blockToDownload == currentNodeBlock) {
      const blocks = await Promise.all(requests).map(async (block) => {
        metrics.downloadedTransactionsCounter.inc(block.tx.length)
        metrics.downloadedBlocksCounter.inc()

        return block
      })

      logger.info(`Flushing blocks ${blocks[0].height}:${blocks[blocks.length - 1].height}`)
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
    logger.info(`Resuming export from position ${JSON.stringify(lastPosition)}`)
  } else {
    await exporter.savePosition(lastProcessedPosition)
    logger.info(`Initialized exporter with initial position ${JSON.stringify(lastProcessedPosition)}`)
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
  metrics.restartCounter.inc()
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
    const msg = `Time from the last export ${timeFromLastExport}ms exceeded limit  ${EXPORT_TIMEOUT_MLS}ms.\
 Last Node block: ${currentNodeBlock}`
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
        .catch((err) => {
          logger.error(`Healthcheck failed: ${err.toString()}`)
          send(response, 500, err.toString())
        })
    case '/metrics':
      response.setHeader('Content-Type', metrics.register.contentType);
      return send(response, 200, metrics.register.metrics())

    default:
      return send(response, 404, 'Not found');
  }
}
