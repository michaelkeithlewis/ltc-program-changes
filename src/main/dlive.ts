import net from 'node:net'
import { EventEmitter } from 'node:events'
import type { ConnectionStatus, DliveConnectionConfig } from '../shared/types'

/**
 * TCP client for Allen & Heath dLive MIDI-over-TCP bridge.
 *
 * Protocol note: dLive exposes a raw MIDI stream on a TCP port (default 51325).
 * Any bytes written to the socket are parsed as MIDI by the mixer. No framing,
 * no handshake. A healthy TCP connection is therefore the "connected" signal.
 *
 * We still layer a light application-level heartbeat on top: every ~3s we
 * write a MIDI Active Sensing byte (0xFE). It is a valid no-op status byte
 * on dLive but confirms the socket is still writable and will surface a
 * broken pipe quickly via the socket error handler.
 */
export class DliveClient extends EventEmitter {
  private socket: net.Socket | null = null
  private status: ConnectionStatus = { state: 'disconnected' }
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private shouldReconnect = false
  private config: DliveConnectionConfig = {
    host: '192.168.1.70',
    port: 51325,
    autoReconnect: true,
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s
    this.emit('status', s)
  }

  connect(cfg?: Partial<DliveConnectionConfig>): ConnectionStatus {
    if (cfg) this.config = { ...this.config, ...cfg }
    this.shouldReconnect = this.config.autoReconnect

    this.teardownSocket()

    this.setStatus({ state: 'connecting' })
    const sock = new net.Socket()
    sock.setNoDelay(true)
    sock.setKeepAlive(true, 1000)

    const onError = (err: Error) => {
      this.setStatus({ state: 'error', message: err.message })
      this.scheduleReconnect()
    }

    sock.once('connect', () => {
      const localPart = sock.localAddress ? ` (via ${sock.localAddress})` : ''
      this.setStatus({
        state: 'connected',
        since: Date.now(),
        remote: `${this.config.host}:${this.config.port}${localPart}`,
      })
      this.startHeartbeat()
    })
    sock.on('error', onError)
    sock.on('close', () => {
      this.stopHeartbeat()
      if (this.status.state === 'connected') {
        this.setStatus({ state: 'disconnected' })
      }
      this.scheduleReconnect()
    })
    sock.on('data', (buf) => {
      // dLive rarely sends MIDI back but pass through anyway so the monitor
      // can show reply bytes for debugging.
      this.emit('data', Array.from(buf))
    })

    // If the user has pinned the control NIC, bind the outbound socket to
    // that local IP so the OS routes the session over the correct
    // interface regardless of routing-table order / metric.
    const localAddress = this.config.localAddress?.trim()
    const connectOpts: {
      host: string
      port: number
      localAddress?: string
      family?: number
    } = {
      host: this.config.host,
      port: this.config.port,
    }
    if (localAddress) {
      connectOpts.localAddress = localAddress
      // Match address family so the kernel doesn't refuse the bind
      // (IPv4 local + IPv6 remote or vice versa).
      connectOpts.family = localAddress.includes(':') ? 6 : 4
    }
    sock.connect(connectOpts)
    this.socket = sock
    return this.status
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.teardownSocket()
    this.setStatus({ state: 'disconnected' })
  }

  send(bytes: number[]): boolean {
    if (!this.socket || this.status.state !== 'connected') return false
    try {
      this.socket.write(Buffer.from(bytes))
      return true
    } catch {
      return false
    }
  }

  private teardownSocket() {
    this.stopHeartbeat()
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect) this.connect()
    }, 1500)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      // 0xFE = MIDI Active Sensing. Treated as a no-op by dLive but lets
      // the kernel surface broken pipes quickly.
      this.send([0xfe])
    }, 3000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
