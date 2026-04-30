import { useEffect, useMemo, useState } from 'react'
import { useApp } from './store'
import { ConnectionPanel } from './components/ConnectionPanel'
import { TimecodeDisplay } from './components/TimecodeDisplay'
import { CueList } from './components/CueList'
import { MidiMonitor } from './components/MidiMonitor'
import { Simulator } from './components/Simulator'
import { WorkspaceBar } from './components/WorkspaceBar'
import { UpdateBanner } from './components/UpdateBanner'
import truckPackerLogo from './assets/truckpacker-logo.png'
import type { AppSettings } from '../../shared/types'

const TRUCK_PACKER_BASE_URL = 'https://truckpacker.com'

function buildTruckPackerUrl(appVersion: string | null): string {
  const url = new URL(TRUCK_PACKER_BASE_URL)
  url.searchParams.set('utm_source', 'ltcpc')
  url.searchParams.set('utm_medium', 'app')
  url.searchParams.set('utm_campaign', 'builtby')
  if (appVersion) url.searchParams.set('utm_content', `v${appVersion}`)
  return url.toString()
}

export function App() {
  const {
    setSettings,
    setCues,
    setStatus,
    appendLog,
    appendLogBatch,
    setLog,
    setReceived,
    setWorkspaces,
    status,
    settings,
    monitorVisible,
    setMonitorVisible,
    theme,
    setTheme,
    applyUpdateEvent,
  } = useApp()

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    return window.api.onUpdateEvent(applyUpdateEvent)
  }, [applyUpdateEvent])

  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    void window.api.system.appVersion().then(setAppVersion)
  }, [])
  const truckPackerHref = useMemo(
    () => buildTruckPackerUrl(appVersion),
    [appVersion],
  )

  useEffect(() => {
    let offStatus: (() => void) | undefined
    let offMidi: (() => void) | undefined
    let offMidiBatch: (() => void) | undefined
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
      offMidiBatch = window.api.onMidiBatch(appendLogBatch)
      offRecv = window.api.onReceived(setReceived)
      offWs = window.api.onWorkspaces(setWorkspaces)
    })()
    return () => {
      offStatus?.()
      offMidi?.()
      offMidiBatch?.()
      offRecv?.()
      offWs?.()
    }
  }, [
    setSettings,
    setCues,
    setStatus,
    appendLog,
    appendLogBatch,
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
        <div className="wordmark" title="LTC → Program Changes">
          <span className="dot" />
          <span>LTCpc</span>
          <span className="sub">LTC → Program Changes · dLive Bridge</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingRight: 4 }}>
          <WorkspaceBar />
        </div>
      </div>

      <div
        className="main"
        style={
          {
            // Two-pane when the monitor is hidden, three-pane otherwise.
            // Inline so it's a one-line change rather than a class swap.
            ['--main-cols' as string]: monitorVisible
              ? '360px 1fr 420px'
              : '360px 1fr',
          } as React.CSSProperties
        }
      >
        <div className="sidebar-stack">
          <ConnectionPanel />
          <TimecodeDisplay />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateRows: '1fr auto',
            minHeight: 0,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
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
          {!monitorVisible && (
            <button
              className="monitor-show-tab"
              onClick={() => setMonitorVisible(true)}
              title="Show MIDI Monitor"
              aria-label="Show MIDI Monitor"
            >
              ‹ MIDI
            </button>
          )}
        </div>

        {monitorVisible && <MidiMonitor />}
      </div>

      <div className="statusbar">
        <span className="status-pill">
          <span className={`status-dot ${dotClass}`} />
          <span>
            dLive{' '}
            {status.state === 'connected'
              ? `· ${status.remote}`
              : `· ${status.state}`}
          </span>
        </span>

        <label className="sb-group" title="Project frame rate (must match your LTC source)">
          <span className="sb-label">FPS</span>
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

        <label className="sb-group" title="Fire each cue this many ms before its timecode">
          <span className="sb-label">Pre-roll</span>
          <input
            type="number"
            value={settings?.preRollMs ?? 0}
            onChange={(e) => setPreRoll(parseInt(e.target.value, 10) || 0)}
            style={{ width: 56 }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>ms</span>
        </label>

        <UpdateBanner />

        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={
            theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
          }
          aria-label={
            theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
          }
          aria-pressed={theme === 'light'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        <a
          className="tp-credit"
          href={truckPackerHref}
          target="_blank"
          rel="noopener"
          title="Visit Truck Packer"
          aria-label="Built by Truck Packer — open landing page"
        >
          <span className="tp-credit-text">Built by</span>
          <img
            src={truckPackerLogo}
            alt="Truck Packer"
            className="tp-credit-logo"
            draggable={false}
          />
        </a>
      </div>
    </div>
  )
}
