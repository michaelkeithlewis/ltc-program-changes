import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import {
  buildDliveSceneRecall,
  buildProgramChange,
  bytesToLabel,
  formatTimecode,
  parseTimecode,
  timecodeToFrames,
} from '../../../shared/midi'
import type { DliveSceneCue, ProgramChangeCue } from '../../../shared/types'

export function Simulator() {
  const settings = useApp((s) => s.settings)
  const setTimecode = useApp((s) => s.setTimecode)
  const clearTimecode = useApp((s) => s.clearTimecode)
  const tcSource = useApp((s) => s.tcSource)
  const currentTc = useApp((s) => s.currentTc)

  const fps = settings?.frameRate ?? 30

  // Simulator transport
  const [tcInput, setTcInput] = useState('00:00:00:00')
  const [running, setRunning] = useState(false)
  const startedAt = useRef<{ wall: number; tcMs: number } | null>(null)

  useEffect(() => {
    if (!running) return
    const h = setInterval(() => {
      if (!startedAt.current) return
      const elapsed = Date.now() - startedAt.current.wall
      const totalMs = startedAt.current.tcMs + elapsed
      const totalFrames = Math.floor((totalMs / 1000) * fps)
      const framesPerSec = Math.round(fps)
      const frames = totalFrames % framesPerSec
      const totalSec = Math.floor(totalFrames / framesPerSec)
      const seconds = totalSec % 60
      const minutes = Math.floor(totalSec / 60) % 60
      const hours = Math.floor(totalSec / 3600) % 24
      setTimecode(
        formatTimecode({ hours, minutes, seconds, frames, dropFrame: false }),
        'simulator',
      )
    }, 1000 / fps / 2) // update at ~2x frame rate for smooth display
    return () => clearInterval(h)
  }, [running, fps, setTimecode])

  function play() {
    const tc = parseTimecode(tcInput) ?? {
      hours: 0,
      minutes: 0,
      seconds: 0,
      frames: 0,
    }
    const tcMs = (timecodeToFrames(tc, fps) / fps) * 1000
    startedAt.current = { wall: Date.now(), tcMs }
    setRunning(true)
  }
  function stop() {
    setRunning(false)
    if (tcSource === 'simulator') clearTimecode()
  }
  function jump() {
    if (tcSource !== 'simulator' && !running) {
      // Still push the current TC in so cues can evaluate.
    }
    setTimecode(tcInput, 'simulator')
  }

  // Manual MIDI test buttons
  const [testCh, setTestCh] = useState(1)
  const [testScene, setTestScene] = useState(1)
  const [testProgram, setTestProgram] = useState(0)

  async function fireTestScene() {
    const cue: DliveSceneCue = {
      id: 'test',
      type: 'dliveScene',
      name: `Test scene ${testScene}`,
      timecode: '',
      enabled: true,
      channel: testCh,
      scene: testScene,
    }
    const bytes = buildDliveSceneRecall(cue)
    await window.api.dlive.sendBytes(bytes, `[test] ${bytesToLabel(bytes)}`)
  }

  async function fireTestPC() {
    const cue: ProgramChangeCue = {
      id: 'test',
      type: 'programChange',
      name: `Test PC ${testProgram}`,
      timecode: '',
      enabled: true,
      channel: testCh,
      program: testProgram,
    }
    const bytes = buildProgramChange(cue)
    await window.api.dlive.sendBytes(bytes, `[test] ${bytesToLabel(bytes)}`)
  }

  return (
    <div
      style={{
        padding: 16,
        borderTop: '1px solid var(--border)',
      }}
    >
      <div className="section-header">
        <h3>Simulator & Test</h3>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>
          {tcSource === 'simulator'
            ? running
              ? 'Running'
              : 'Paused'
            : 'Idle'}
        </span>
      </div>

      <div className="sim-grid">
        {/* Timecode simulator */}
        <div className="sim-block">
          <h3>Virtual Timecode</h3>
          <div className="transport">
            <input
              className="tc-input"
              value={running ? currentTc || tcInput : tcInput}
              onChange={(e) => setTcInput(e.target.value)}
              disabled={running}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {!running ? (
              <button className="primary" onClick={play}>
                ▶ Play
              </button>
            ) : (
              <button className="danger" onClick={stop}>
                ■ Stop
              </button>
            )}
            <button onClick={jump} disabled={running}>
              Jump
            </button>
          </div>
          <div
            style={{
              marginTop: 8,
              color: 'var(--muted)',
              fontSize: 11,
            }}
          >
            Cues will fire against this virtual timecode, exactly as they
            would with live LTC.
          </div>
        </div>

        {/* Manual MIDI fire */}
        <div className="sim-block">
          <h3>Send MIDI Manually</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>Channel</div>
              <input
                type="number"
                min={1}
                max={16}
                value={testCh}
                onChange={(e) => setTestCh(parseInt(e.target.value, 10) || 1)}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>Scene</div>
              <input
                type="number"
                min={1}
                max={500}
                value={testScene}
                onChange={(e) => setTestScene(parseInt(e.target.value, 10) || 1)}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>PC #</div>
              <input
                type="number"
                min={0}
                max={127}
                value={testProgram}
                onChange={(e) =>
                  setTestProgram(parseInt(e.target.value, 10) || 0)
                }
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={fireTestScene}>Fire dLive Scene</button>
            <button onClick={fireTestPC}>Fire Program Change</button>
          </div>
        </div>
      </div>
    </div>
  )
}
