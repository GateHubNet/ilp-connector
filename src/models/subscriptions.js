'use strict'

const co = require('co')
const log = require('../common').log.create('subscriptions')
const payments = require('../models/payments')

function * subscribePairs (core, config, routeBuilder, messageRouter, backend) {
  const handleIncoming = (client, transfer) => {
    console.log('ftw 1');
    return co(function * () {
      yield payments.updateIncomingTransfer(transfer, core, config, routeBuilder)
    }).catch(logThenThrow)
  }
  core.on('incoming_prepare', handleIncoming)
  core.on('incoming_transfer', handleIncoming)

  core.on('outgoing_cancel', (client, transfer, rejectionMessage) => {
    console.log('ftw 2');
    return co(payments.rejectSourceTransfer, transfer, rejectionMessage, core)
      .catch(logThenThrow)
  })

  core.on('outgoing_reject', (client, transfer, rejectionMessage) => {
    console.log('ftw 3');
    return co(payments.rejectSourceTransfer, transfer, rejectionMessage, core)
      .catch(logThenThrow)
  })

  core.on('outgoing_fulfill', (client, transfer, fulfillment) => {
    console.log('ftw 4');
    return co(function * () {
      yield payments.processExecutionFulfillment(transfer, fulfillment, core, backend, config)
    }).catch(logThenThrow)
  })

  core.on('incoming_message', (client, message) => {
    console.log('ftw 5');
    return messageRouter.handleMessage(message)
      .catch(logThenThrow)
  })
}

function logThenThrow (err) {
  debugger;
  log.warn('error processing notification: ' + err)
  throw err
}

module.exports = { subscribePairs }
