const { EventEmitter } = require('events')

// A stand-in for the VEDirect connection: records how many were built, and
// lets a test replay open/data/error/close on whichever one is current.
class MockVEDirect extends EventEmitter {
  constructor (path) {
    super()
    this.path = path
    this.closeCalls = 0
    this.closeCallback = null
    MockVEDirect.instances.push(this)
  }

  close (callback) {
    this.closeCalls++
    this.closeCallback = callback
    if (!this.holdClose) {
      process.nextTick(() => callback && callback(null))
    }
  }
}

MockVEDirect.instances = []

const mockList = jest.fn()

jest.mock('serialport', () => ({ SerialPort: { list: mockList } }))
jest.mock('../../../src/services/vedirect', () => MockVEDirect)

const registerNode = require('../../../src/nodes/vedirect-usb')
const { MAX_DELAY_MS } = require('../../../src/lib/reconnect-policy')
const { DEFAULT_LIVENESS_TIMEOUT_MS } = require('../../../src/lib/stale-detector')

// Backoff is jittered, so no test may assume an exact delay. Stepping past the
// hard cap always lands after whatever delay was picked.
const PAST_BACKOFF = MAX_DELAY_MS + 1

const PID_FRAME = { PID: { value: '0xA389', product: 'SmartShunt 500A/50mV' } }

let VEDirectUSB

const RED = {
  nodes: {
    createNode: () => {},
    registerType: (_name, ctor) => { VEDirectUSB = ctor }
  },
  httpAdmin: { get: () => {} },
  log: { error: () => {} }
}

registerNode(RED)

// Let the SerialPort.list() promise chain inside connect() run to completion.
const settle = () => new Promise((resolve) => setImmediate(resolve))

function buildNode (config = {}) {
  const node = new EventEmitter()
  node.status = jest.fn()
  node.warn = jest.fn()
  node.send = jest.fn()
  node.log = jest.fn()

  VEDirectUSB.call(node, { port: '/dev/ttyUSB0', timeout: 10, ...config })

  return node
}

const current = () => MockVEDirect.instances[MockVEDirect.instances.length - 1]
const lastStatus = (node) => node.status.mock.calls[node.status.mock.calls.length - 1][0]

// Bring a node to the point where a connection is open and a frame has landed.
async function connectedNode (config) {
  const node = buildNode(config)
  await settle()
  current().emit('open')
  current().emit('data', PID_FRAME)
  return node
}

async function closeNode (node) {
  await new Promise((resolve) => node.emit('close', resolve))
}

describe('VEDirectUSB node', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    MockVEDirect.instances = []
    mockList.mockReset()
    mockList.mockResolvedValue([])
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should open the configured port and report connecting', async () => {
    const node = buildNode()

    expect(lastStatus(node)).toEqual({ fill: 'blue', shape: 'ring', text: 'connecting' })

    await settle()

    expect(MockVEDirect.instances).toHaveLength(1)
    expect(current().path).toBe('/dev/ttyUSB0')

    await closeNode(node)
  })

  it('should show the product name once a frame arrives', async () => {
    const node = await connectedNode()

    expect(lastStatus(node)).toEqual({
      fill: 'green',
      shape: 'dot',
      text: 'SmartShunt 500A/50mV'
    })

    await closeNode(node)
  })

  it('should wait for data rather than call a fresh connection stale', async () => {
    const node = buildNode()
    await settle()
    current().emit('open')

    jest.advanceTimersByTime(1000)

    expect(lastStatus(node)).toEqual({ fill: 'yellow', shape: 'ring', text: 'waiting for data' })

    await closeNode(node)
  })

  it('should build a new connection after the port closes', async () => {
    const node = await connectedNode()

    current().emit('close', { disconnected: true })

    expect(lastStatus(node)).toEqual({
      fill: 'yellow',
      shape: 'ring',
      text: 'reconnecting (disconnected)'
    })
    expect(MockVEDirect.instances).toHaveLength(1)

    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(2)

    await closeNode(node)
  })

  // Regression: the liveness check anchored on lastDataTime alone, so a
  // timestamp from before the disconnect made every fresh connection look
  // stale one second after opening, and the node reconnect-looped forever.
  it('should not tear down a fresh connection because of pre-disconnect data', async () => {
    const node = await connectedNode({ timeout: 10 })

    // Go silent so the watchdog reconnects; lastDataTime is now well past the
    // timeout by the time the replacement connection opens.
    jest.advanceTimersByTime(11000)
    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(2)
    current().emit('open')

    jest.advanceTimersByTime(5000) // inside the 10s timeout, no frame yet

    expect(MockVEDirect.instances).toHaveLength(2)

    // Still "stale data" rather than "waiting for data": the pre-disconnect
    // frame is kept so a partial first frame doesn't lose the other fields.
    expect(lastStatus(node)).toEqual({ fill: 'yellow', shape: 'ring', text: 'stale data' })

    await closeNode(node)
  })

  it('should reconnect when an open port goes silent', async () => {
    const node = await connectedNode({ timeout: 10 })

    jest.advanceTimersByTime(11000)

    expect(lastStatus(node)).toEqual({
      fill: 'yellow',
      shape: 'ring',
      text: 'reconnecting (no data)'
    })

    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(2)

    await closeNode(node)
  })

  it('should supervise liveness even when stale detection is disabled', async () => {
    const node = await connectedNode({ timeout: '' })

    jest.advanceTimersByTime(DEFAULT_LIVENESS_TIMEOUT_MS - 1000)
    expect(MockVEDirect.instances).toHaveLength(1)

    jest.advanceTimersByTime(2000)
    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(2)

    await closeNode(node)
  })

  it('should hold the error message on screen while retrying', async () => {
    const node = buildNode()
    await settle()
    current().emit('error', new Error('Permission denied'))

    expect(lastStatus(node)).toEqual({
      fill: 'red',
      shape: 'dot',
      text: 'Permission denied'
    })

    await closeNode(node)
  })

  it('should warn once per distinct failure, not once per attempt', async () => {
    const node = buildNode()
    await settle()

    for (let i = 0; i < 4; i++) {
      current().emit('error', new Error('Permission denied'))
      jest.advanceTimersByTime(PAST_BACKOFF)
      await settle()
    }

    expect(node.warn).toHaveBeenCalledTimes(1)
    expect(node.warn.mock.calls[0][0]).toMatch(/Permission denied/)

    await closeNode(node)
  })

  it('should warn again when the failure changes', async () => {
    const node = buildNode()
    await settle()

    current().emit('error', new Error('Permission denied'))
    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()
    current().emit('error', new Error('No such file or directory'))

    expect(node.warn).toHaveBeenCalledTimes(2)

    await closeNode(node)
  })

  it('should reset the backoff and log recovery once data returns', async () => {
    const node = buildNode()
    await settle()

    current().emit('error', new Error('Permission denied'))
    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    current().emit('open')
    current().emit('data', PID_FRAME)

    expect(node.log).toHaveBeenCalledTimes(1)
    expect(node.log.mock.calls[0][0]).toMatch(/1 reconnection attempt/)

    // Backoff restarted, so the next retry lands well inside the cap.
    current().emit('close', {})
    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()
    expect(MockVEDirect.instances).toHaveLength(3)

    await closeNode(node)
  })

  it('should re-resolve the port on every attempt', async () => {
    const node = buildNode({ port: '/dev/ttyUSB0', serialNumber: 'HQ2123ABCDE' })
    mockList.mockResolvedValue([{ path: '/dev/ttyUSB0', serialNumber: 'HQ2123ABCDE' }])
    await settle()

    // The cable comes back on a different device name after a replug.
    mockList.mockResolvedValue([{ path: '/dev/ttyUSB3', serialNumber: 'HQ2123ABCDE' }])
    current().emit('close', { disconnected: true })
    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(current().path).toBe('/dev/ttyUSB3')

    await closeNode(node)
  })

  it('should stop reconnecting once the node is closed', async () => {
    const node = await connectedNode()

    current().emit('close', { disconnected: true })
    await closeNode(node)

    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(1)
  })

  it('should not open a port when the node closes mid-resolution', async () => {
    const node = buildNode()

    await closeNode(node)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(0)
  })

  it('should wait for an in-flight reader close before reporting closed', async () => {
    const node = await connectedNode()
    const reader = current()
    reader.holdClose = true

    // Node close lands during the backoff, while the old reader is still going.
    reader.emit('close', { disconnected: true })
    expect(reader.closeCalls).toBe(1)

    let done = false
    const closing = new Promise((resolve) => {
      node.emit('close', () => { done = true; resolve() })
    })

    await settle()
    expect(done).toBe(false)

    reader.closeCallback(null)
    await closing

    expect(done).toBe(true)
  })

  it('should not schedule two reconnects for one failure', async () => {
    const node = await connectedNode()

    current().emit('error', new Error('boom'))
    current().emit('close', { disconnected: true })

    jest.advanceTimersByTime(PAST_BACKOFF)
    await settle()

    expect(MockVEDirect.instances).toHaveLength(2)

    await closeNode(node)
  })

  it('should send accumulated data on input and withhold it when stale', async () => {
    const node = await connectedNode({ timeout: 10 })

    node.emit('input', {})
    expect(node.send).toHaveBeenCalledTimes(1)
    expect(node.send.mock.calls[0][0].payload.PID.product).toBe('SmartShunt 500A/50mV')

    jest.advanceTimersByTime(11000)
    node.emit('input', {})

    expect(node.send).toHaveBeenCalledTimes(1)

    await closeNode(node)
  })

  it('should not let an input overwrite a live reconnecting status', async () => {
    const node = await connectedNode({ timeout: 10 })

    current().emit('close', { disconnected: true })
    node.emit('input', {})

    expect(lastStatus(node)).toEqual({
      fill: 'yellow',
      shape: 'ring',
      text: 'reconnecting (disconnected)'
    })

    await closeNode(node)
  })
})
