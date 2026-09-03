const { SerialPort } = require('serialport')
const { DelimiterParser } = require('@serialport/parser-delimiter')
const VEDirectParser = require('./parser')
const { EventEmitter } = require('events')
const { Writable } = require('stream')
const debug = require('debug')

const debugSerial = debug('vedirect:serial')
const debugDelimiter = debug('vedirect:delimiter')
const debugParser = debug('vedirect:parser')
const debugOutput = debug('vedirect:output')

/**
 * One VE.Direct connection: an open serial port plus the pipe chain that turns
 * its bytes into frames. The pipe chain cannot outlive the port (ending the
 * readable side ends every stream downstream of it), so a connection is
 * single-use: on 'close' the owner must throw it away and build a new one.
 *
 * @emits open  once the port is open
 * @emits data  for every complete, checksum-valid frame
 * @emits error on a serial port error
 * @emits close once the port is gone, with `{ disconnected }`
 */
class VEDirect extends EventEmitter {
  constructor (path) {
    super()

    debugSerial('Creating serial port on %s', path)

    this.closed = false
    this.opening = true
    this.closing = false
    this.disposed = false
    this.pendingClose = []

    this.serial = new SerialPort({
      path,
      baudRate: 19200,
      dataBits: 8,
      parity: 'none'
    })

    this.serial.on('open', () => {
      debugSerial('Serial port opened successfully')
      this.opening = false
      this.emit('open')
    })

    this.serial.on('error', (err) => {
      debugSerial('Serial port error: %o', err)
      this.opening = false
      this.emit('error', err)
    })

    // A disconnect (USB unplug, driver reset) surfaces here and *not* on
    // 'error': serialport turns it into close(undefined, DisconnectedError).
    this.serial.on('close', (err) => {
      debugSerial('Serial port closed: %o', err)
      this._closed({ disconnected: Boolean(err && err.disconnected) })
    })

    // A zero-byte read ends the readable side without any close or error, so
    // the pipe chain goes quiet while the port still looks open.
    this.serial.on('end', () => {
      debugSerial('Serial port stream ended')
      this._closed({ disconnected: true })
    })

    this.serial.on('data', (data) => {
      debugSerial('Received %d bytes: %s', data.length, data.toString('hex').substring(0, 40))
    })

    this.rl = new DelimiterParser({
      delimiter: Buffer.from([0x0d, 0x0a], 'hex'),
      includeDelimiter: false
    })

    this.rl.on('data', (line) => {
      debugDelimiter('Parsed line: %s', line.toString())
    })

    this.ve = new VEDirectParser()

    let frameCount = 0

    // Create a Writable stream to consume the parser output
    // This is what makes the Transform stream actually emit data
    this.output = new Writable({
      objectMode: true,
      write: (data, encoding, callback) => {
        frameCount++
        debugParser('Parser emitted frame #%d with fields: %s', frameCount, Object.keys(data).join(', '))

        if (data.PID) {
          debugParser('  PID: %s (%s)', data.PID.value, data.PID.product || 'unknown product')
        }

        debugOutput('Emitting data event for frame #%d', frameCount)
        this.emit('data', data)
        callback()
      }
    })

    debugSerial('Setting up pipe chain: serial -> delimiter -> parser -> output')

    // Complete the pipe chain: serial -> delimiter -> parser -> output
    this.serial.pipe(this.rl).pipe(this.ve).pipe(this.output)

    debugSerial('Pipe chain established')
  }

  _closed (info) {
    if (this.closed) {
      return
    }

    this.closed = true
    this.emit('close', info)
  }

  /**
   * Tear the connection down. Safe to call more than once, and on a port that
   * is already gone. Never emits 'close' - the caller is the one closing.
   * @param {function=} callback - Called with the close error, or null, once the port is closed
   */
  close (callback) {
    const done = callback || (() => {})

    this.closed = true

    if (this.disposed) {
      return process.nextTick(() => done(null))
    }

    // Queue late callers behind an in-flight close. Re-running the teardown
    // would strip the listeners the first close is waiting on, and its
    // callback - which is Node-RED's `done` - would never fire.
    if (this.closing) {
      this.pendingClose.push(done)
      return
    }

    this.closing = true
    this.pendingClose = [done]

    this.serial.unpipe(this.rl)
    this.rl.unpipe(this.ve)
    this.ve.unpipe(this.output)

    // Drop our listeners before closing so a late frame, or the close we are
    // about to cause, can't reach an owner that has already moved on.
    this.removeAllListeners()
    this.serial.removeAllListeners('open')
    this.serial.removeAllListeners('close')
    this.serial.removeAllListeners('end')
    this.serial.removeAllListeners('error')
    this.serial.on('error', (err) => debugSerial('Error after close: %o', err))

    const finish = (err) => {
      if (err) {
        debugSerial('Error closing serial port: %o', err)
      }

      this.opening = false
      this.closing = false
      this.disposed = true

      const callbacks = this.pendingClose
      this.pendingClose = []

      // Always async, so a caller's callback never runs before close() returns.
      process.nextTick(() => callbacks.forEach((cb) => cb(err || null)))
    }

    const closePort = () => this.serial.close(finish)

    if (this.serial.isOpen) {
      return closePort()
    }

    // Closing mid-open would leave the pending open to succeed unowned, so
    // wait for it to land (or fail) first.
    if (this.opening) {
      debugSerial('Close requested while still opening')
      this.serial.once('open', closePort)
      this.serial.once('error', finish)
      return
    }

    debugSerial('Close requested but port is not open')
    finish(null)
  }
}

module.exports = VEDirect
