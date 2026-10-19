import { describe, expect, test } from 'vitest'
import { isOrphanedGatewayHandshakeError } from './gateway-handshake-error.js'

function wsError(message: string, ErrorType: ErrorConstructor = Error): Error {
  const error = new ErrorType(message)
  error.stack = `${ErrorType.name}: ${message}\n    at ClientRequest.<anonymous> (/app/node_modules/ws/lib/websocket.js:904:7)`
  return error
}

describe('isOrphanedGatewayHandshakeError', () => {
  test('matches the ws handshake timeout', () => {
    expect(isOrphanedGatewayHandshakeError(wsError('Opening handshake has timed out'))).toBe(true)
  })

  test('rejects other errors so they still restart the bot', () => {
    expect(isOrphanedGatewayHandshakeError(wsError('Invalid Sec-WebSocket-Accept header'))).toBe(false)
    expect(isOrphanedGatewayHandshakeError(wsError('Opening handshake has timed out', TypeError))).toBe(false)
    expect(isOrphanedGatewayHandshakeError(new Error('Opening handshake has timed out'))).toBe(false)
    expect(isOrphanedGatewayHandshakeError('Opening handshake has timed out')).toBe(false)
  })
})
