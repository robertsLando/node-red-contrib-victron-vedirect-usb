module.exports = function (RED) {
  'use strict'
  const fs = require('fs')
  const path = require('path')
  const VEDirect = require('../services/vedirect')
  const { SerialPort } = require('serialport')
  const {
    parseTimeout,
    isStale,
    getStatusDisplay,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR
  } = require('../lib/stale-detector')
  const { resolveSerialPort } = require('../lib/port-resolver')
  const { nextDelay } = require('../lib/reconnect-policy')
  const debug = require('debug')('vedirect:node')

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
    let closed = false
    let accumulatedData = {} // Accumulated data across all frames
    let productName = null
    let dataEventCount = 0
    let lastDataTime = null
    let connectedAt = null
    let staleCheckInterval = null
    let reconnectTimer = null
    let reconnectAttempts = 0
    let connection = { state: CONNECTING }

    // Parse timeout configuration
    const timeoutMs = parseTimeout(config.timeout)

    debug('Stale detection timeout: %s ms', timeoutMs)

    // Function to update status based on current state
    function updateStatus () {
      const stale = isStale(lastDataTime, timeoutMs)
      const status = getStatusDisplay(stale, productName, connection)

      if (stale) {
        debug('Data is stale')
      }

      node.status(status)
    }

    function setConnection (state, error) {
      connection = { state, error }
      updateStatus()
    }

    // Drop the current connection and open a fresh one after a backoff delay.
    // The pipe chain inside a VEDirect cannot be restarted once its serial
    // stream has ended, so recovery always means building a new one.
    function scheduleReconnect (reason) {
      if (closed || reconnectTimer) {
        return
      }

      const delay = nextDelay(reconnectAttempts)
      reconnectAttempts++

      debug('Reconnecting in %d ms (attempt #%d) after %s', delay, reconnectAttempts, reason)

      // Keep a reported error on screen through the backoff window; it says
      // why we are retrying, which a bare "reconnecting" would throw away.
      if (connection.state !== ERROR) {
        setConnection(RECONNECTING)
      }

      connectedAt = null

      const reader = dataReader
      dataReader = null

      if (reader) {
        reader.close()
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    function connect () {
      if (closed) {
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
          if (closed) {
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
            reconnectAttempts = 0
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

            if (connection.state !== CONNECTED) {
              connection = { state: CONNECTED }
            }

            updateStatus()
          })

          reader.on('error', (error) => {
            debug('Error from dataReader: %o', error)
            node.warn(error)
            setConnection(ERROR, error.message || String(error))
            scheduleReconnect('error')
          })

          // A disconnect reaches us as 'close', never as 'error'.
          reader.on('close', (info) => {
            debug('Connection closed (disconnected: %s)', info && info.disconnected)
            scheduleReconnect('close')
          })
        })
        .catch((err) => {
          debug('Failed to open serial port: %o', err)
          node.warn(err)
          setConnection(ERROR, err.message || String(err))
          scheduleReconnect('open failure')
        })
    }

    // Watch for a connection that is open but silent. A VE.Direct device can
    // stop transmitting while the file descriptor stays valid, which produces
    // no serial event at all, so stale data is the only symptom to act on.
    if (timeoutMs) {
      debug('Starting stale data check interval')
      staleCheckInterval = setInterval(() => {
        // Measure silence from the last frame, or from the moment the port
        // opened when no frame has arrived yet - otherwise a connection would
        // be torn down a second after opening, before its first frame lands.
        if (connection.state === CONNECTED && isStale(lastDataTime || connectedAt, timeoutMs)) {
          scheduleReconnect('stale data')
          return
        }

        updateStatus()
      }, 1000) // Check every second
    }

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
        node.status({ fill: 'yellow', shape: 'ring', text: 'waiting for data' })
      }
      node.send(msg)
    })

    node.on('close', function (done) {
      debug('Closing node, clearing timers and closing serial port')
      closed = true

      if (staleCheckInterval) {
        clearInterval(staleCheckInterval)
        staleCheckInterval = null
      }

      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      const reader = dataReader
      dataReader = null

      if (!reader) {
        return done()
      }

      reader.close(done)
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
