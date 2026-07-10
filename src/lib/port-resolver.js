/**
 * Serial port resolution utilities
 * Pure functions for resolving a stable device path from a list of available ports
 */

/**
 * Resolve the serial port path to open, preferring a match on serial number
 * over the configured path. Linux does not guarantee that ttyUSB* device
 * names stay attached to the same physical device across reboots/replugs,
 * but the USB serial number does not change.
 * @param {string} configuredPath - The path stored in the node configuration (e.g. /dev/ttyUSB0)
 * @param {string|null|undefined} serialNumber - The USB serial number stored in the node configuration, if any
 * @param {Array<{path: string, serialNumber?: string}>} availablePorts - Result of SerialPort.list()
 * @returns {string} The path that should be opened
 */
function resolveSerialPort (configuredPath, serialNumber, availablePorts) {
  // A /dev/serial/by-id/... path is already a stable udev symlink tied to the
  // device's vendor/product/serial number, so it survives ttyUSB* renumbering
  // on its own and never needs to be re-resolved.
  if (configuredPath && configuredPath.startsWith('/dev/serial/by-id/')) {
    return configuredPath
  }

  if (!serialNumber) {
    return configuredPath
  }

  const match = (availablePorts || []).find((port) => port.serialNumber === serialNumber)

  return match ? match.path : configuredPath
}

module.exports = {
  resolveSerialPort
}
