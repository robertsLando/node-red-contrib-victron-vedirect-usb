/**
 * Stale data detection utilities
 * Pure functions for detecting when data becomes stale based on timeout configuration
 */

// Used to supervise the connection when stale detection is switched off. A
// healthy VE.Direct device sends a frame about every second, so a minute of
// silence means the link is dead even if the port still looks open, and the
// node would otherwise sit there forever with no detector at all.
const DEFAULT_LIVENESS_TIMEOUT_MS = 60000

/**
 * Parse timeout configuration value
 * @param {*} configValue - The timeout value from node configuration
 * @returns {number|null} Timeout in milliseconds, or null if disabled
 */
function parseTimeout (configValue) {
  if (configValue === undefined || configValue === null || configValue === '') {
    return null
  }

  const parsed = parseFloat(configValue)
  if (isNaN(parsed) || parsed <= 0) {
    return null
  }

  return parsed * 1000 // Convert seconds to milliseconds
}

/**
 * Check if data is stale based on last received time and timeout
 * @param {number|null} lastDataTime - Timestamp when data was last received (Date.now() format)
 * @param {number|null} timeoutMs - Timeout in milliseconds, or null if disabled
 * @param {number} currentTime - Current timestamp (for testability, defaults to Date.now())
 * @returns {boolean} True if data is stale, false otherwise
 */
function isStale (lastDataTime, timeoutMs, currentTime = Date.now()) {
  // Timeout disabled
  if (!timeoutMs) {
    return false
  }

  // No data received yet
  if (!lastDataTime) {
    return true
  }

  // Check if timeout exceeded
  return (currentTime - lastDataTime) > timeoutMs
}

module.exports = {
  parseTimeout,
  isStale,
  DEFAULT_LIVENESS_TIMEOUT_MS
}
