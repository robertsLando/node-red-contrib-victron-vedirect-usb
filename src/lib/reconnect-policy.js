/**
 * Reconnect backoff policy
 * Pure functions for spacing out serial port reconnection attempts
 */

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000
const JITTER_RATIO = 0.2

/**
 * Delay before the given reconnection attempt.
 * Exponential backoff, capped, with jitter so several nodes losing the same
 * USB hub don't all retry in lockstep.
 * @param {number} attempt - Number of consecutive failed attempts so far (0 for the first retry)
 * @param {function} random - Source of randomness in [0, 1) (for testability, defaults to Math.random)
 * @returns {number} Delay in milliseconds
 */
function nextDelay (attempt, random = Math.random) {
  const exponent = Math.max(0, Math.floor(attempt) || 0)
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, exponent), MAX_DELAY_MS)
  const jitter = base * JITTER_RATIO * (random() * 2 - 1)

  // Clamp after jitter, not before: jittering the cap would overshoot the
  // maximum delay this module documents.
  return Math.min(MAX_DELAY_MS, Math.round(base + jitter))
}

module.exports = {
  nextDelay,
  BASE_DELAY_MS,
  MAX_DELAY_MS
}
