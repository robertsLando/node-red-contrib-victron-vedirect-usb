const { resolveSerialPort } = require('../../../src/lib/port-resolver')

describe('port-resolver', () => {
  describe('resolveSerialPort', () => {
    test('should return configured path when no serial number is set', () => {
      const ports = [{ path: '/dev/ttyUSB0', serialNumber: 'VE9X91HJ' }]
      expect(resolveSerialPort('/dev/ttyUSB0', undefined, ports)).toBe('/dev/ttyUSB0')
    })

    test('should return configured path when serial number is empty string', () => {
      const ports = [{ path: '/dev/ttyUSB0', serialNumber: 'VE9X91HJ' }]
      expect(resolveSerialPort('/dev/ttyUSB0', '', ports)).toBe('/dev/ttyUSB0')
    })

    test('should return configured path when serial number is null', () => {
      const ports = [{ path: '/dev/ttyUSB0', serialNumber: 'VE9X91HJ' }]
      expect(resolveSerialPort('/dev/ttyUSB0', null, ports)).toBe('/dev/ttyUSB0')
    })

    test('should resolve to the current path matching the serial number', () => {
      const ports = [
        { path: '/dev/ttyUSB0', serialNumber: 'VE2OV3R7' },
        { path: '/dev/ttyUSB1', serialNumber: 'VE9X91HJ' }
      ]
      // Device previously known as ttyUSB1 is now ttyUSB0
      expect(resolveSerialPort('/dev/ttyUSB1', 'VE2OV3R7', ports)).toBe('/dev/ttyUSB0')
    })

    test('should fall back to configured path when serial number is not found', () => {
      const ports = [{ path: '/dev/ttyUSB0', serialNumber: 'VE9X91HJ' }]
      expect(resolveSerialPort('/dev/ttyUSB1', 'DOES-NOT-EXIST', ports)).toBe('/dev/ttyUSB1')
    })

    test('should fall back to configured path when no ports are available', () => {
      expect(resolveSerialPort('/dev/ttyUSB0', 'VE9X91HJ', [])).toBe('/dev/ttyUSB0')
    })

    test('should handle undefined availablePorts', () => {
      expect(resolveSerialPort('/dev/ttyUSB0', 'VE9X91HJ', undefined)).toBe('/dev/ttyUSB0')
    })

    test('should never re-resolve a /dev/serial/by-id path, even without a serial number', () => {
      const byIdPath = '/dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE2OV3R7-if00-port0'
      expect(resolveSerialPort(byIdPath, undefined, [])).toBe(byIdPath)
    })

    test('should never re-resolve a /dev/serial/by-id path, even with a mismatching serial number', () => {
      const byIdPath = '/dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE2OV3R7-if00-port0'
      const ports = [{ path: '/dev/ttyUSB0', serialNumber: 'SOME-OTHER-DEVICE' }]
      expect(resolveSerialPort(byIdPath, 'VE2OV3R7', ports)).toBe(byIdPath)
    })
  })
})
