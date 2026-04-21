import { useEffect } from 'react'
import { useApp } from './store'
import { ConnectionPanel } from './components/ConnectionPanel'
import { TimecodeDisplay } from './components/TimecodeDisplay'
import { CueList } from './components/CueList'
import { MidiMonitor } from './components/MidiMonitor'
import { Simulator } from './components/Simulator'
import { WorkspaceBar } from './components/WorkspaceBar'
import type { AppSettings } from '../../shared/types'

export function App() {
  const {
    setSettings,
    setCues,
    setStatus,
    appendLog,
    setLog,
    setReceived,
    setWorkspaces,
    status,
    settings,
  } = useApp()

  useEffect(() => {
    let offStatus: (() => void) | undefined
    let offMidi: (() => void) | undefined
    let offRecv: (() => void) | undefined
    let offWs: (() => void) | undefined
    ;(async () => {
      const [s, cues, st, recent, received, wsList] = await Promise.all([
        window.api.settings.get(),
        window.api.cues.list(),
        window.api.dlive.status(),
        window.api.log.recent(),
        window.api.log.received(),
        window.api.workspaces.list(),
      ])
      setSettings(s)
      setCues(cues)
      setStatus(st)
      setLog(recent)
      setReceived(received)
      setWorkspaces(wsList)
      offStatus = window.api.onStatus(setStatus)
      offMidi = window.api.onMidi(appendLog)
      offRecv = window.api.onReceived(setReceived)
      offWs = window.api.onWorkspaces(setWorkspaces)
    })()
    return () => {
      offStatus?.()
      offMidi?.()
      offRecv?.()
      offWs?.()
    }
  }, [
    setSettings,
    setCues,
    setStatus,
    appendLog,
    setLog,
    setReceived,
    setWorkspaces,
  ])

  async function setFps(fps: AppSettings['frameRate']) {
    const next = await window.api.settings.set({ frameRate: fps })
    setSettings(next)
  }

  async function setPreRoll(ms: number) {
    const next = await window.api.settings.set({ preRollMs: ms })
    setSettings(next)
  }

  const dotClass =
    status.state === 'connected'
      ? 'connected'
      : status.state === 'connecting'
        ? 'connecting'
        : status.state === 'error'
          ? 'error'
          : ''

  return (
    <div className="app">
      <div className="titlebar">
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          LTC → Program Changes · dLive Bridge
        </div>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: 10 }}>
          <WorkspaceBar />
        </div>
      </div>

      <div className="main">
        <ConnectionPanel />

        <div
          style={{
            display: 'grid',
            gridTemplateRows: 'auto 1fr auto',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '20px 20px 16px' }}>
            <TimecodeDisplay />
          </div>
          <div
            style={{
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <CueList />
          </div>
          <Simulator />
        </div>

        <MidiMonitor />
      </div>

      <div className="statusbar">
        <span className="status-pill">
          <span className={`status-dot ${dotClass}`} />
          dLive{' '}
          {status.state === 'connected'
            ? `· ${status.remote}`
            : `· ${status.state}`}
        </span>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Frame rate:
          <select
            value={settings?.frameRate ?? 30}
            onChange={(e) =>
              setFps(parseFloat(e.target.value) as AppSettings['frameRate'])
            }
          >
            <option value={24}>24</option>
            <option value={25}>25</option>
            <option value={29.97}>29.97</option>
            <option value={30}>30</option>
          </select>
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Pre-roll (ms):
          <input
            type="number"
            value={settings?.preRollMs ?? 0}
            onChange={(e) => setPreRoll(parseInt(e.target.value, 10) || 0)}
            style={{ width: 80 }}
          />
        </label>

        <span style={{ marginLeft: 'auto' }}>
          Tip: workspaces auto-save. Export from the workspace menu to back
          them up or share.
        </span>
      </div>
    </div>
  )
}
