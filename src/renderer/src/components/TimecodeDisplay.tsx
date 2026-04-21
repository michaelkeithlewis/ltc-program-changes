import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import { LtcReader } from '../ltc/LtcReader'

export function TimecodeDisplay() {
  const currentTc = useApp((s) => s.currentTc)
  const tcSource = useApp((s) => s.tcSource)
  const tcLastAt = useApp((s) => s.tcLastAt)
  const setTimecode = useApp((s) => s.setTimecode)
  const clearTimecode = useApp((s) => s.clearTimecode)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [listening, setListening] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const readerRef = useRef<LtcReader | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(i)
  }, [])

  useEffect(() => {
    async function enumerate() {
      try {
        // Request permission so device labels populate.
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
        tmp.getTracks().forEach((t) => t.stop())
      } catch {
        /* user will see error on Start Listening */
      }
      const list = await navigator.mediaDevices.enumerateDevices()
      const inputs = list.filter((d) => d.kind === 'audioinput')
      setDevices(inputs)
      if (!deviceId && inputs[0]) setDeviceId(inputs[0].deviceId)
    }
    enumerate()
  }, [deviceId])

  async function start() {
    setError(null)
    const reader = new LtcReader()
    readerRef.current = reader
    await reader.start(deviceId || undefined, {
      onTimecode: (tc) => setTimecode(tc, 'ltc'),
      onLevel: setLevel,
      onError: (e) => {
        setError(e.message)
        setListening(false)
      },
    })
    setListening(true)
  }

  async function stop() {
    await readerRef.current?.stop()
    readerRef.current = null
    setListening(false)
    setLevel(0)
    if (tcSource === 'ltc') clearTimecode()
  }

  const stale = tcSource === 'ltc' && Date.now() - tcLastAt > 500
  const display = currentTc || '--:--:--:--'
  const levelPct = Math.min(100, Math.round(level * 300))

  return (
    <div>
      <div className={`tc-display ${stale ? 'stale' : ''}`}>{display}</div>
      <div className="tc-sub">
        Source:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {tcSource === 'none' ? '—' : tcSource === 'ltc' ? 'LTC audio' : 'Simulator'}
        </strong>
        {tcSource === 'ltc' && stale && (
          <span style={{ color: 'var(--warn)', marginLeft: 8 }}>· signal lost</span>
        )}
      </div>

      <div
        style={{
          marginTop: 20,
          padding: 14,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-2)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <strong style={{ fontSize: 13 }}>LTC Audio Input</strong>
          <span style={{ color: 'var(--muted)', fontSize: 11 }}>
            {listening ? 'Decoding…' : 'Idle'}
          </span>
        </div>

        <div className="field">
          <label>Input Device</label>
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={listening}
          >
            {devices.length === 0 && <option value="">No inputs found</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </div>

        {/* Level meter */}
        <div
          style={{
            height: 6,
            background: 'var(--bg)',
            borderRadius: 3,
            overflow: 'hidden',
            marginBottom: 10,
          }}
        >
          <div
            style={{
              width: `${levelPct}%`,
              height: '100%',
              background: levelPct > 2 ? 'var(--good)' : 'var(--muted)',
              transition: 'width 0.08s linear',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {!listening ? (
            <button className="primary" onClick={start}>
              Start Listening
            </button>
          ) : (
            <button className="danger" onClick={stop}>
              Stop Listening
            </button>
          )}
        </div>
        {error && (
          <div style={{ color: 'var(--bad)', marginTop: 8, fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
