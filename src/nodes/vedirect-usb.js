module.exports = function (RED) {
  'use strict'
  const fs = require('fs')
  const path = require('path')
  const VEDirect = require('../services/vedirect')
  const { SerialPort } = require('serialport')
  const { parseTimeout, isStale } = require('../lib/stale-detector')
  const {
    getStatusDisplay,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR,
    REASON_CLOSE,
    REASON_STALE,
    REASON_ERROR,
    REASON_OPEN_FAILURE
  } = require('../lib/connection-status')
  const { resolveSerialPort } = require('../lib/port-resolver')
  const { nextDelay, LIVENESS_TIMEOUT_MS } = require('../lib/reconnect-policy')
  const debug = require('debug')('vedirect:node')

  // How often the supervisor looks at the connection. Frequent enough that the
  // status badge tracks reality, cheap enough to run forever.
  const LIVENESS_CHECK_INTERVAL_MS = 1000

  // Re-warn every this many attempts during a long outage, so the log shows an
  // outage is ongoing without one line per retry.
  const WARN_REPEAT_ATTEMPTS = 10

  // /dev/serial/by-id/... symlinks are maintained by udev on Linux and stay
  // pointing at the same physical device across reboots/replugs, unlike
  // /dev/ttyUSB* device names which can swap around. Where available, attach
  // that stable path to each listed port so it can be offered in the UI.
  function withByIdPaths (ports) {
    const byIdDir = '/dev/serial/by-id'
    let entries

    try {
      entries = fs.readdirSync(byIdDir)
    } catch (err) {
      // Not on Linux, or no by-id symlinks present (e.g. macOS, Windows)
      return ports
    }

    const byIdPathByRealPath = {}
    entries.forEach((entry) => {
      const linkPath = path.join(byIdDir, entry)
      try {
        byIdPathByRealPath[fs.realpathSync(linkPath)] = linkPath
      } catch (err) {
        debug('Skipping broken symlink %s: %o', linkPath, err)
      }
    })

    return ports.map((port) => {
      const byId = byIdPathByRealPath[port.path]
      return byId ? { ...port, byId } : port
    })
  }

  function VEDirectUSB (config) {
    RED.nodes.createNode(this, config)

    const node = this
    debug('Initializing VEDirectUSB node on port %s', config.port)

    let dataReader = null
    let shuttingDown = false
    let accumulatedData = {} // Accumulated data across all frames
    let productName = null
    let dataEventCount = 0
    let lastDataTime = null
    let connectedAt = null
    let livenessInterval = null
    let reconnectTimer = null
    let reconnectAttempts = 0
    let failingSince = null
    let lastWarned = null
    let connection = {}

    // Readers whose close() is still in flight. Node-RED must not report the
    // node closed while a file descriptor is still held, or the redeploy that
    // follows reopens the same path against a port the kernel has not released.
    const closingReaders = new Set()

    const timeoutMs = parseTimeout(config.timeout)

    // "Is the output fresh enough to send" and "is the link dead" are different
    // questions, so the output timeout only ever lengthens the supervision
    // window. Reusing a short timeout here would tear down a healthy port
    // between two frames.
    const livenessMs = Math.max(timeoutMs || 0, LIVENESS_TIMEOUT_MS)

    debug('Stale detection timeout: %s ms, liveness timeout: %d ms', timeoutMs, livenessMs)

    function updateStatus () {
      node.status(getStatusDisplay({
        ...connection,
        hasData: lastDataTime !== null,
        stale: isStale(lastDataTime, timeoutMs),
        productName
      }))
    }

    function setConnection (state, extra) {
      connection = { state, ...extra }
      updateStatus()
    }

    // Warn once per distinct failure rather than once per attempt: a cable that
    // flaps for a week would otherwise bury every other log line. Repeat every
    // WARN_REPEAT_ATTEMPTS tries so a long outage still leaves a trail, and
    // carry the attempt count and elapsed time so one line answers "how bad".
    function reportFailure (message) {
      const attempt = reconnectAttempts + 1

      if (!failingSince) {
        failingSince = Date.now()
      }

      if (message === lastWarned && attempt % WARN_REPEAT_ATTEMPTS !== 0) {
        debug('Suppressing repeat failure on attempt #%d: %s', attempt, message)
        return
      }

      lastWarned = message
      const seconds = Math.round((Date.now() - failingSince) / 1000)
      node.warn(`${message} (attempt ${attempt}, failing for ${seconds}s, retrying)`)
    }

    // Close a reader without blocking, but keep the handle so node close can
    // wait for it.
    function disposeReader (reader) {
      if (!reader) {
        return
      }

      let settle
      const finished = new Promise((resolve) => { settle = resolve })
      closingReaders.add(finished)

      reader.close((err) => {
        if (err) {
          reportFailure(`Failed to close serial port: ${err.message || err}`)
        }
        closingReaders.delete(finished)
        settle()
      })
    }

    // Drop the current connection and open a fresh one after a backoff delay.
    // The pipe chain inside a VEDirect cannot be restarted once its serial
    // stream has ended, so recovery always means building a new one.
    function scheduleReconnect (reason) {
      if (shuttingDown || reconnectTimer) {
        return
      }

      const delay = nextDelay(reconnectAttempts)
      reconnectAttempts++

      debug('Reconnecting in %d ms (attempt #%d) after %s', delay, reconnectAttempts, reason)

      // Keep a reported error on screen through the backoff window; it says
      // why we are retrying, which a bare "reconnecting" would throw away.
      if (connection.state !== ERROR) {
        setConnection(RECONNECTING, { reason })
      }

      connectedAt = null

      const reader = dataReader
      dataReader = null
      disposeReader(reader)

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    // Every way a connection can fail ends the same way: say so, show it, retry.
    function failConnection (message, reason) {
      reportFailure(message)
      setConnection(ERROR, { error: message })
      scheduleReconnect(reason)
    }

    // A lost link and a silent device are the two commonest field faults, and
    // both used to retry in complete silence.
    function loseConnection (message, reason) {
      reportFailure(message)
      scheduleReconnect(reason)
    }

    function connect () {
      if (shuttingDown) {
        return
      }

      setConnection(CONNECTING)

      // Resolve the port to open, preferring the USB serial number (if configured)
      // over the raw path, since Linux does not guarantee ttyUSB* names stay
      // attached to the same physical device across reboots/replugs. Re-resolved
      // on every attempt: after a replug the device may be on a different path.
      SerialPort.list()
        .then((ports) => resolveSerialPort(config.port, config.serialNumber, ports))
        .catch((err) => {
          debug('Failed to list serial ports, falling back to configured path: %o', err)
          return config.port
        })
        .then((resolvedPath) => {
          if (shuttingDown) {
            return
          }

          if (resolvedPath !== config.port) {
            debug('Resolved serial number %s to %s (configured path was %s)', config.serialNumber, resolvedPath, config.port)
          }

          const reader = new VEDirect(resolvedPath)
          dataReader = reader

          reader.on('open', () => {
            debug('Serial port open on %s', resolvedPath)
            connectedAt = Date.now()
            setConnection(CONNECTED)
          })

          reader.on('data', (data) => {
            dataEventCount++
            lastDataTime = Date.now()

            // A frame arrived, so this connection works: forget past failures
            // and start the next backoff from scratch.
            if (reconnectAttempts > 0) {
              const seconds = Math.round((Date.now() - failingSince) / 1000)
              node.log(`Receiving data again after ${reconnectAttempts} attempt(s) over ${seconds}s`)
              reconnectAttempts = 0
              failingSince = null
              lastWarned = null
            }

            debug('Received data event #%d at %d', dataEventCount, lastDataTime)
            debug('Frame has %d fields', Object.keys(data).length)

            // Merge new data into accumulated data (overwrites existing fields)
            accumulatedData = { ...accumulatedData, ...data }

            debug('Accumulated data now has %d total fields', Object.keys(accumulatedData).length)

            // Store and display product name when we first see it
            if (data.PID && data.PID.product) {
              productName = data.PID.product
              debug('Product identified: %s', productName)
            }

            setConnection(CONNECTED)
          })

          reader.on('error', (error) => {
            debug('Error from dataReader: %o', error)
            failConnection(error.message || String(error), REASON_ERROR)
          })

          // A disconnect reaches us as 'close', never as 'error'.
          reader.on('close', (info) => {
            debug('Connection closed (disconnected: %s)', info && info.disconnected)
            loseConnection(`Lost the serial connection to ${resolvedPath}`, REASON_CLOSE)
          })
        })
        .catch((err) => {
          debug('Failed to open serial port: %o', err)
          failConnection(err.message || String(err), REASON_OPEN_FAILURE)
        })
    }

    // Watch for a connection that is open but silent. A VE.Direct device can
    // stop transmitting while the file descriptor stays valid, which produces
    // no serial event at all, so silence is the only symptom to act on. The
    // same tick repaints the badge, which is why it runs even when stale
    // detection is switched off.
    livenessInterval = setInterval(() => {
      // Measure silence from whichever came last, the newest frame or the
      // moment this connection opened. Anchoring on lastDataTime alone would
      // carry a timestamp from before the disconnect into the fresh
      // connection and tear it down a second after opening.
      const lastActivity = Math.max(lastDataTime || 0, connectedAt || 0) || null

      if (connection.state === CONNECTED && isStale(lastActivity, livenessMs)) {
        loseConnection(`No data for ${Math.round(livenessMs / 1000)}s`, REASON_STALE)
        return
      }

      updateStatus()
    }, LIVENESS_CHECK_INTERVAL_MS)

    connect()

    let inputCount = 0

    node.on('input', function (msg) {
      inputCount++
      debug('Input triggered #%d', inputCount)

      // Check if data is stale
      if (isStale(lastDataTime, timeoutMs)) {
        debug('Data is stale, not sending output')
        updateStatus()
        return // Don't send anything
      }

      // Output the accumulated data containing all fields seen so far
      if (Object.keys(accumulatedData).length > 0) {
        debug('Sending accumulated data with %d fields', Object.keys(accumulatedData).length)
        msg.payload = accumulatedData
      } else {
        debug('No data available yet')
        msg.payload = {}
      }

      updateStatus()
      node.send(msg)
    })

    node.on('close', function (done) {
      debug('Closing node, clearing timers and closing serial port')
      shuttingDown = true

      clearInterval(livenessInterval)
      livenessInterval = null

      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      const reader = dataReader
      dataReader = null
      disposeReader(reader)

      // Also wait on any reader a reconnect was already closing.
      Promise.all(closingReaders).then(() => done())
    })
  }

  RED.nodes.registerType('victron-vedirect-usb', VEDirectUSB)

  RED.httpAdmin.get('/victron/vedirect-ports', (_req, res) => {
    SerialPort.list().then((ports) => {
      res.json(withByIdPaths(ports))
    }, (err) => {
      RED.log.error(err)
      res.status(500).json({ error: err.message })
    })
  })
}
