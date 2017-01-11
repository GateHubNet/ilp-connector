'use strict'

const co = require('co')
const defer = require('co-defer')
const Route = require('ilp-routing').Route
const log = require('../common').log.create('route-broadcaster')
const SIMPLIFY_POINTS = 10

class RouteBroadcaster {
  /**
   * @param {RoutingTables} routingTables
   * @param {Backend} backend
   * @param {Ledgers} ledgers
   * @param {InfoCache} infoCache
   * @param {Object} config
   * @param {Number} config.minMessageWindow
   * @param {Number} config.routeCleanupInterval
   * @param {Number} config.routeBroadcastInterval
   * @param {Boolean} config.autoloadPeers
   * @param {URI[]} config.peers
   * @param {Object} config.ledgerCredentials
   */
  constructor (routingTables, backend, ledgers, infoCache, config) {
    if (!ledgers) {
      throw new TypeError('Must be given a valid Core instance')
    }

    this.routeCleanupInterval = config.routeCleanupInterval
    this.routeBroadcastInterval = Number(config.routeBroadcastInterval)
    this.routingTables = routingTables
    if (this.routingTables.publicTables.current_epoch !== 0) throw new Error('expecting a fresh routingTables with epoch support')
    this.backend = backend
    this.ledgers = ledgers
    this.infoCache = infoCache
    this.minMessageWindow = config.minMessageWindow
    this.ledgerCredentials = config.ledgerCredentials
    this.configRoutes = config.configRoutes

    this.autoloadPeers = config.autoloadPeers
    this.defaultPeers = config.peers
    this.peersByLedger = {} // { ledgerPrefix ⇒ { connectorName ⇒ true } }

    this.peerEpochs = {} // { adjacentConnector ⇒ int } the last broadcast-epoch we successfully informed a peer in
    this.holdDownTime = Number(config.routeExpiry) // todo? replace 'expiry' w/ hold-down or just reappropriate the term?
    if (!this.holdDownTime) {
      throw new Error('no holdDownTime')
    }
    if (this.routeBroadcastInterval >= this.holdDownTime) {
      throw new Error('holdDownTime must be greater than routeBroadcastInterval or routes will expire between broadcasts!')
    }
    this.detectedDown = new Set()
    this.lastNewRouteSentAt = Date.now()
  }

  * start () {
    yield this.crawl()
    try {
      yield this.reloadLocalRoutes()
      yield this.addConfigRoutes()
      this.broadcast()
    } catch (e) {
      if (e.name === 'SystemError' ||
          e.name === 'ServerError') {
        // System error, in that context that is a network error
        // This will be retried later, so do nothing
      } else {
        throw e
      }
    }
    log.info('cleanup interval:', this.routeCleanupInterval)
    setInterval(() => {
      let lostLedgerLinks = this.routingTables.removeExpiredRoutes()
      this.markLedgersUnreachable(lostLedgerLinks)
    }, this.routeCleanupInterval)

    log.info('broadcast interval:', this.routeBroadcastInterval, ' holdDownTime:', this.holdDownTime)
    defer.setInterval(function * () { this.broadcast() }.bind(this), this.routeBroadcastInterval)
  }
  markLedgersUnreachable (lostLedgerLinks) {
    if (lostLedgerLinks.length > 0) log.info('detected lostLedgerLinks:', lostLedgerLinks)
    lostLedgerLinks.map((unreachableLedger) => { this.detectedDown.add(unreachableLedger) })
  }
  _currentEpoch () {
    return this.routingTables.publicTables.current_epoch
  }
  _endEpoch () {
    this.routingTables.publicTables.incrementEpoch()
  }
  broadcast () {
    const adjacentLedgers = Object.keys(this.peersByLedger)
    const routes = this.routingTables.toJSON(SIMPLIFY_POINTS)
    const unreachableLedgers = Array.from(this.detectedDown)
    this.detectedDown.clear()
    log.info('broadcast unreachableLedgers:', unreachableLedgers)
    for (let adjacentLedger of adjacentLedgers) {
      const ledgerRoutes = routes.filter((route) => route.source_ledger === adjacentLedger)
      try {
        this._broadcastToLedger(adjacentLedger, ledgerRoutes, unreachableLedgers)
      } catch (err) {
        log.warn('broadcasting routes on ledger ' + adjacentLedger + ' failed')
        log.debug(err)
      }
    }
    this._endEpoch()
  }

  _broadcastToLedger (adjacentLedger, routes, unreachableLedgers) {
    const connectors = Object.keys(this.peersByLedger[adjacentLedger])
    for (let adjacentConnector of connectors) {
      const account = adjacentLedger + adjacentConnector
      const routesNewToConnector = routes.filter((route) => (route.added_during_epoch > (this.peerEpochs[account] || -1)))
      // todo: get added_during_epoch another way, strip it here, or add it to spec
      if (unreachableLedgers.length > 0) log.info('_broadcastToLedger unreachableLedgers:', unreachableLedgers)
      const broadcastPromise = this.ledgers.getPlugin(adjacentLedger).sendMessage({
        ledger: adjacentLedger,
        account: account,
        data: {
          method: 'broadcast_routes',
          data: {
            new_routes: routesNewToConnector,
            hold_down_time: this.holdDownTime,
            unreachable_through_me: unreachableLedgers
          }
        }
      })
      // timeout the plugin.sendMessage Promise just so we don't have it hanging around forever
      const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('route broadcast to ' + account + ' timed out')), this.routeBroadcastInterval)
      })

      // We are deliberately calling an async function synchronously because
      // we do not want to wait for the routes to be broadcasted before continuing.
      // Even if there is an error sending a specific route or a sendMessage promise hangs,
      // we should continue sending the other broadcasts out
      Promise.race([broadcastPromise, timeoutPromise])
        .then((val) => {
          this.peerEpochs[account] = this._currentEpoch()
        })
        .catch((err) => {
          let lostLedgerLinks = this.routingTables.invalidateConnector(account)
          log.info('detectedDown! account:', account, 'lostLedgerLinks:', lostLedgerLinks)
          this.markLedgersUnreachable(lostLedgerLinks)
          // todo: better would be for the possibly-just-netsplit connector to report its last seen version of this connector's ledger
          this.peerEpochs[account] = -1
          log.warn('broadcasting routes to ' + account + ' failed')
          log.debug(err)
        })
    }
  }

  crawl () {
    return this.ledgers.getClients().map(this._crawlClient, this)
  }

  * _crawlClient (client) {
    yield this._crawlLedgerPlugin(client.getPlugin())
  }

  * _crawlLedgerPlugin (plugin) {
    const prefix = yield plugin.getPrefix()
    const localAccount = yield plugin.getAccount()
    const info = yield plugin.getInfo()
    for (const connector of (info.connectors || []).map(c => c.name)) {
      // Don't broadcast routes to ourselves.
      if (localAccount === prefix + connector) continue
      if (this.autoloadPeers || this.defaultPeers.indexOf(prefix + connector) !== -1) {
        this.peersByLedger[prefix] = this.peersByLedger[prefix] || {}
        this.peersByLedger[prefix][connector] = true
        log.info('adding peer ' + connector + ' via ledger ' + prefix)
      }
    }
  }

  depeerLedger (prefix) {
    delete this.peersByLedger[prefix]
  }

  * reloadLocalRoutes () {
    const localRoutes = yield this._getLocalRoutes()
    yield this.routingTables.addLocalRoutes(this.infoCache, localRoutes)
  }

  _getLocalRoutes () {
    return Promise.all(this.ledgers.getPairs().map(
      (pair) => co.wrap(this._tradingPairToLocalRoute).call(this, pair)))
  }

  addConfigRoutes () {
    for (let configRoute of this.configRoutes) {
      const connectorLedger = configRoute.connectorLedger
      const connector = configRoute.connectorAccount
      const targetPrefix = configRoute.targetPrefix

      const route = new Route(
        // use a 1:1 curve as a placeholder (it will be overwritten by a remote quote)
        [ [0, 0], [1, 1] ],
        // the second ledger is inserted to make sure this the hop to the
        // connectorLedger is not considered final.
        [ connectorLedger, targetPrefix ],
        { minMessageWindow: this.minMessageWindow,
          sourceAccount: connector,
          targetPrefix: targetPrefix }
      )

      this.routingTables.addRoute(route)
    }

    // returns a promise in order to be similar to reloadLocalRoutes()
    return Promise.resolve(null)
  }

  * _tradingPairToLocalRoute (pair) {
    const sourceLedger = pair[0].split('@').slice(1).join('@')
    const destinationLedger = pair[1].split('@').slice(1).join('@')
    const sourceCurrency = pair[0].split('@')[0]
    const destinationCurrency = pair[1].split('@')[0]
    const curve = yield this.backend.getCurve({
      source_ledger: sourceLedger,
      destination_ledger: destinationLedger,
      source_currency: sourceCurrency,
      destination_currency: destinationCurrency
    })
    const sourcePlugin = this.ledgers.getPlugin(sourceLedger)
    const destinationPlugin = this.ledgers.getPlugin(destinationLedger)
    const destinationInfo = yield this.infoCache.get(destinationLedger)
    return Route.fromData({
      source_ledger: sourceLedger,
      destination_ledger: destinationLedger,
      additional_info: curve.additional_info,
      min_message_window: this.minMessageWindow,
      source_account: (yield sourcePlugin.getAccount()),
      destination_account: (yield destinationPlugin.getAccount()),
      points: curve.points,
      destinationPrecision: destinationInfo.precision,
      destinationScale: destinationInfo.scale
    }, this._currentEpoch())
  }
}

module.exports = RouteBroadcaster
