# UTXO Transactions Exporter

This code allows you to fetch all transactions from UTXO based blockchains to kafka.

## Setup

Because all data is fetched from public end-point, so no need to use k8s proxy or vpn to run the service locally.  

You need to have access to a full node to run this. The easiest way to get access to one is to use the Litecoind server we have on staging. The easiest way to access is via [VPN](https://community.santiment.net/t/openvpn-instructions/272).

## Running the service

The easiest way to run the service is using `docker-compose`:

Example:

```bash
$ docker-compose up --build
```

## Configure

You can configure the service with the following ENV variables:

* NODE\_URL - Litecoind server addr. Default: `http://litecoind.default.svc.cluster.local:9332`
* RPC\_USERNAME/RPC\_PASSWORD - Credential to access the Litecoind server.
* DEFAULT\_TIMEOUT - Network read/connection timeout for communication with the Litecoind server. Default: `10000`
* SEND\_BATCH\_SIZE - Size of batch to send data to kafka topic. Default: `10`
* CONFIRMATIONS - Number of confirmations to ways until the data is exported. An easy way to handle blockchain reorganizations. Default: `3`
* BLOCK - The block numer from which to start exporting the events. Default: `1`
* EXPORT\_TIMEOUT\_MLS - max time interval between successful data pushing to kafka to treat the service as healthy. Default: `1000 * 60 * 15, 15 minutes`


#### Health checks

You can make health check GET requests to the service. The health check makes a request to Kafka to make sure the connection is not lost and also checks time from the previous pushing data to kafka (or time of the service start if no data pushed yet):
:

```bash
curl http://localhost:3000/healthcheck
```

If the health check passes you get response code 200 and response message `ok`.
If the health check does not pass you get response code 500 and a message describing what failed.

## Running the tests

Tests are not imlemented yet :(
