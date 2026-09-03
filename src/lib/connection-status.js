/**
 * Connection state and status rendering
 * Pure functions mapping the supervisor's view of the serial connection onto
 * the status badge Node-RED shows under the node
 */

const CONNECTING = 'connecting'
const CONNECTED = 'connected'
const RECONNECTING = 'reconnecting'
const ERROR = 'error'

// Why we gave up on the previous connection, phrased for the status badge.
// The operator needs "replug the cable" to look different from "the device
// went quiet", which a bare "reconnecting" does not tell them.
const REASON_TEXT = {
  close: 'disconnected',
  'stale data': 'no data',
  error: 'error',
  'open failure': 'cannot open'
}

/**
 * Render the status badge for the current connection.
 *
 * Connection state outranks data state: while the port is down, "stale data"
 * is a symptom rather than the thing the operator needs to see, and the
 * periodic liveness check must never paint over a connection error.
 * @param {Object} status - Current view of the connection
 * @param {string} status.state - One of 'connecting', 'connected', 'reconnecting', 'error'
 * @param {string} [status.error] - Error message, when state is 'error'
 * @param {string} [status.reason] - Why we are reconnecting, when state is 'reconnecting'
 * @param {boolean} [status.hasData] - Whether any frame has ever been received
 * @param {boolean} [status.stale] - Whether the received data is now stale
 * @param {string} [status.productName] - The product name, if known
 * @returns {Object} Status object with fill, shape, and text properties
 */
function getStatusDisplay (status) {
  const { state, error, reason, hasData, stale, productName } = status || {}

  if (state === ERROR) {
    return { fill: 'red', shape: 'dot', text: error || 'error' }
  }

  if (state === CONNECTING) {
    return { fill: 'blue', shape: 'ring', text: 'connecting' }
  }

  if (state === RECONNECTING) {
    const why = REASON_TEXT[reason]
    return { fill: 'yellow', shape: 'ring', text: why ? `reconnecting (${why})` : 'reconnecting' }
  }

  if (!hasData) {
    return { fill: 'yellow', shape: 'ring', text: 'waiting for data' }
  }

  if (stale) {
    return { fill: 'yellow', shape: 'ring', text: 'stale data' }
  }

  return { fill: 'green', shape: 'dot', text: productName || 'connected' }
}

module.exports = {
  getStatusDisplay,
  CONNECTING,
  CONNECTED,
  RECONNECTING,
  ERROR
}
