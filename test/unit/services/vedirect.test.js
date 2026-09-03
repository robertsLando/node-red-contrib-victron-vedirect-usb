const { PassThrough } = require('stream')

// A stand-in for SerialPort: a readable stream that can be fed bytes and can
// replay the lifecycle events the real driver emits (open, close, end, error).
class MockSerialPort extends PassThrough {
  constructor (options) {
    super()
    this.options = options
    this.isOpen = false
    this.closeCallbacks = []
    MockSerialPort.instances.push(this)
  }

  open () {
    this.isOpen = true
    this.emit('open')
  }

  close (callback) {
    if (!this.isOpen) {
      return process.nextTick(() => callback && callback(new Error('Port is not open')))
    }
    this.isOpen = false
    this.closeCallbacks.push(callback)
    process.nextTick(() => callback && callback(null))
  }

  disconnect () {
    this.isOpen = false
    const err = new Error('device disconnected')
    err.disconnected = true
    this.emit('close', err)
  }
}

MockSerialPort.instances = []

jest.mock('serialport', () => ({ SerialPort: MockSerialPort }))

const VEDirect = require('../../../src/services/vedirect')
const { toWireFrame, smartShuntFrame } = require('../../fixtures/vedirect-frames')

const VALID_FRAME = toWireFrame(smartShuntFrame)

describe('VEDirect', () => {
  let port

  beforeEach(() => {
    MockSerialPort.instances = []
  })

  function build () {
    const reader = new VEDirect('/dev/ttyUSB0')
    port = MockSerialPort.instances[MockSerialPort.instances.length - 1]
    return reader
  }

  it('should open the configured path at the VE.Direct baud rate', () => {
    build()
    expect(port.options).toMatchObject({ path: '/dev/ttyUSB0', baudRate: 19200 })
  })

  it('should emit open when the port opens', () => {
    const reader = build()
    const onOpen = jest.fn()
    reader.on('open', onOpen)

    port.open()

    expect(onOpen).toHaveBeenCalled()
  })

  it('should emit parsed frames as data', (done) => {
    const reader = build()
    port.open()

    reader.on('data', (frame) => {
      expect(frame.PID).toBeDefined()
      done()
    })

    port.write(VALID_FRAME)
  })

  it('should emit close with disconnected when the device is unplugged', (done) => {
    const reader = build()
    port.open()

    reader.on('close', (info) => {
      expect(info).toEqual({ disconnected: true })
      done()
    })

    port.disconnect()
  })

  it('should emit close when the readable side ends without any error', (done) => {
    const reader = build()
    port.open()

    reader.on('close', (info) => {
      expect(info).toEqual({ disconnected: true })
      done()
    })

    port.end()
  })

  it('should emit close only once', () => {
    const reader = build()
    port.open()
    const onClose = jest.fn()
    reader.on('close', onClose)

    port.disconnect()
    port.emit('close')
    port.emit('end')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('should re-emit serial port errors', () => {
    const reader = build()
    const onError = jest.fn()
    reader.on('error', onError)
    const err = new Error('boom')

    port.emit('error', err)

    expect(onError).toHaveBeenCalledWith(err)
  })

  it('should not emit close when the owner closes it', (done) => {
    const reader = build()
    port.open()
    const onClose = jest.fn()
    reader.on('close', onClose)

    reader.close(() => {
      expect(onClose).not.toHaveBeenCalled()
      expect(port.isOpen).toBe(false)
      done()
    })
  })

  it('should stop emitting data once closed', (done) => {
    const reader = build()
    port.open()
    const onData = jest.fn()
    reader.on('data', onData)

    reader.close(() => {
      port.write(VALID_FRAME)
      setImmediate(() => {
        expect(onData).not.toHaveBeenCalled()
        done()
      })
    })
  })

  it('should call back when closing a port that never opened', (done) => {
    const reader = build()
    reader.on('error', () => {})
    // Report the failed open the way serialport does, so we are not "opening".
    port.emit('error', new Error('ENOENT'))

    reader.close(done)
  })

  it('should wait for a pending open before closing', (done) => {
    const reader = build()
    expect(reader.opening).toBe(true)

    reader.close(() => {
      expect(port.isOpen).toBe(false)
      done()
    })

    port.open()
  })

  it('should be safe to close more than once', (done) => {
    const reader = build()
    port.open()

    reader.close(() => {
      reader.close(done)
    })
  })
})
