const pkg = require('./package.json');
const { send } = require('micro')
const url = require('url')
const { Exporter } = require('san-exporter')
const rp = require('request-promise')
const uuidv1 = require('uuid/v1')
const metrics = require('./src/metrics')

const exporter = new Exporter(pkg.name)

const SEND_BATCH_SIZE = parseInt(process.env.SEND_BATCH_SIZE || "30")
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_WS_TIMEOUT || "1000")
const CONNECTIONS_COUNT = parseInt(process.env.CONNECTIONS_COUNT || "1")
const NODE_URL = process.env.NODE_URL || 'litecoind.default.svc.cluster.local'

let lastProcessedPosition = {
  blockNumber: parseInt(process.env.BLOCK || "1"),
}

console.log('Fetch XRPL transactions')

const connectionSend = (async (method, params) => {
  metrics.requestsCounter.inc()

  const startTime = new Date()
  rp({
    method: 'POST',
    uri: NODE_URL,
    body: {
      jsonrpc: '1.0',
      id: uuidv1(),
      method: method,
      params: params
    },
    timeout: DEFAULT_TIMEOUT,
    json: true
  }).then(({result, error}) => {
    metrics.requestsResponseTime.observe(new Date() - startTime)

    if(error) {
      return Promise.reject(error)
    }

    return result
  })
})
  
const fetchBlock = async (block_index) => {
  let blockHash = await connectionSend('getblockhash', [block_index])
  return await connectionSend('getblock', [blockHash, 2])
}

async function work() {
  const currentBlockReq = await connectionSend('getblockchaininfo', [])

  const currentBlock = currentBlockReq.result.blocks
  metrics.currentBlock.set(currentBlock)

  const requests = []

  console.info(`Fetching transfers for interval ${lastProcessedPosition.blockNumber}:${currentBlock}`)

  while (lastProcessedPosition.blockNumber + requests.length < currentBlock) {
    const blockToDownload = lastProcessedPosition.blockNumber + requests.length

    requests.push(fetchBlock(blockToDownload))

    if (requests.length >= SEND_BATCH_SIZE || blockToDownload == currentBlock) {
      const blocks = await Promise.all(requests).map(async (block) => {
        metrics.downloadedTransactionsCounter.inc(block.tx.length)
        metrics.downloadedBlocksCounter.inc()

        return block
      })

      console.log(`Flushing blocks ${blocks[0].height}:${blocks[ledgers.length - 1].height}`)
      await exporter.sendDataWithKey(ledgers, "height")

      lastProcessedPosition.blockNumber += ledgers.length
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
      console.log(`Progressed to position ${JSON.stringify(lastProcessedPosition)}`)

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
