import { useEffect, useState } from 'react'
import { useApp } from '../store'
import type { ConnectionStatus } from '../../../shared/types'

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

  useEffect(() => {
    if (settings) {
      setHost(settings.dlive.host)
      setPort(String(settings.dlive.port))
      setAuto(settings.dlive.autoReconnect)
    }
  }, [settings])

  async function onConnect() {
    await window.api.dlive.connect({
      host,
      port: parseInt(port, 10) || 51325,
      autoReconnect: auto,
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

        <div
          style={{
            marginTop: 20,
            padding: 10,
            borderRadius: 6,
            background: 'var(--bg-3)',
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--text)' }}>dLive setup:</strong>
          <br />
          In Director / Surface, enable Network MIDI under Utility → Control →
          MIDI, and route MIDI to the relevant Scenes / Softkeys. The
          factory-default TCP port is <code>51325</code>.
        </div>
      </div>
    </div>
  )
}
