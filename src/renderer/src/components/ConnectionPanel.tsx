import { useEffect, useState } from 'react'
import { useApp } from '../store'
import type {
  ConnectionStatus,
  NetworkInterfaceInfo,
} from '../../../shared/types'

function statusLabel(s: ConnectionStatus): string {
  switch (s.state) {
    case 'disconnected':
      return 'Disconnected'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return `Connected · ${s.remote}`
    case 'error':
      return `Error: ${s.message}`
  }
}

export function ConnectionPanel() {
  const settings = useApp((s) => s.settings)
  const status = useApp((s) => s.status)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('51325')
  const [auto, setAuto] = useState(true)
  const [localAddress, setLocalAddress] = useState('')
  const [nics, setNics] = useState<NetworkInterfaceInfo[]>([])

  useEffect(() => {
    if (settings) {
      setHost(settings.dlive.host)
      setPort(String(settings.dlive.port))
      setAuto(settings.dlive.autoReconnect)
      setLocalAddress(settings.dlive.localAddress ?? '')
    }
  }, [settings])

  // Refresh the NIC list on mount and every 5s while the panel is open,
  // so a newly-plugged USB-Ethernet adapter or a DHCP-changed IP shows up
  // without having to restart the app.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const list = await window.api.system.listNetworkInterfaces()
        if (!cancelled) setNics(list)
      } catch {
        // Non-fatal; just leave the previous list in place.
      }
    }
    refresh()
    const t = setInterval(refresh, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  async function onConnect() {
    await window.api.dlive.connect({
      host,
      port: parseInt(port, 10) || 51325,
      autoReconnect: auto,
      localAddress: localAddress || undefined,
    })
  }

  async function onDisconnect() {
    await window.api.dlive.disconnect()
  }

  const dotClass =
    status.state === 'connected'
      ? 'connected'
      : status.state === 'connecting'
        ? 'connecting'
        : status.state === 'error'
          ? 'error'
          : ''

  const since =
    status.state === 'connected'
      ? `${Math.floor((Date.now() - status.since) / 1000)}s`
      : null

  return (
    <div className="panel">
      <h2>dLive Connection</h2>
      <div className="panel-body">
        <div className="status-pill" style={{ marginBottom: 16 }}>
          <span className={`status-dot ${dotClass}`} />
          <span>{statusLabel(status)}</span>
          {since && <span style={{ color: 'var(--muted)' }}>· {since}</span>}
        </div>

        <div className="field">
          <label>dLive IP / Host</label>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.70"
          />
        </div>
        <div className="field">
          <label>TCP Port</label>
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="51325"
          />
        </div>
        <div className="field">
          <label>Control NIC</label>
          <select
            value={localAddress}
            onChange={(e) => setLocalAddress(e.target.value)}
          >
            <option value="">Automatic (OS routing table)</option>
            {nics.map((n) => (
              <option key={`${n.name}-${n.address}`} value={n.address}>
                {n.name} — {n.address}
                {n.family === 'IPv6' ? ' (IPv6)' : ''}
              </option>
            ))}
            {localAddress &&
              !nics.some((n) => n.address === localAddress) && (
                <option value={localAddress}>
                  {localAddress} (not currently available)
                </option>
              )}
          </select>
        </div>
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 14,
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          Auto-reconnect
        </label>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={onConnect}>
            {status.state === 'connected' ? 'Reconnect' : 'Connect'}
          </button>
          <button onClick={onDisconnect} disabled={status.state === 'disconnected'}>
            Disconnect
          </button>
        </div>

      </div>
    </div>
  )
}
