// @discordjs/ws (1.2.3, unchanged on upstream main) WebSocketShard.destroy()
// sets `connection.onerror = null` but only closes sockets whose readyState is
// OPEN. A socket still CONNECTING is left without an error listener, so when
// its handshake timer fires, ws emits 'error' on a bare EventEmitter and Node
// raises it as an uncaughtException. The shard has already reconnected on a new
// socket, so this one error is harmless and must not restart the bot.

const WS_HANDSHAKE_TIMEOUT = 'Opening handshake has timed out'

/** True only for the ws handshake-timeout Error raised by an orphaned gateway socket. */
export function isOrphanedGatewayHandshakeError(error: unknown): boolean {
  return error instanceof Error
    && error.constructor === Error
    && error.message === WS_HANDSHAKE_TIMEOUT
    && /[\\/]ws[\\/]lib[\\/]websocket\.js/.test(error.stack ?? '')
}
