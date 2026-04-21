import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import { LtcReader } from '../ltc/LtcReader'

export function TimecodeDisplay() {
  const currentTc = useApp((s) => s.currentTc)
  const tcSource = useApp((s) => s.tcSource)
  const tcLastAt = useApp((s) => s.tcLastAt)
  const setTimecode = useApp((s) => s.setTimecode)
  const clearTimecode = useApp((s) => s.clearTimecode)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [channel, setChannel] = useState<number>(1)
  const [channelCount, setChannelCount] = useState<number>(1)
  const [listening, setListening] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const readerRef = useRef<LtcReader | null>(null)
  const [, setTick] = useState(0)

  // Repaint for the "stale" badge.
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(i)
  }, [])

  // Load persisted device/channel when settings arrive.
  useEffect(() => {
    if (!settings) return
    if (settings.audioInputDeviceId && !deviceId) {
      setDeviceId(settings.audioInputDeviceId)
    }
    if (settings.audioInputChannel && channel === 1) {
      setChannel(settings.audioInputChannel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  // Enumerate audio inputs. Requesting permission once gives us labels.
  useEffect(() => {
    async function enumerate() {
      try {
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
    const onChange = () => enumerate()
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () =>
      navigator.mediaDevices.removeEventListener('devicechange', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function persistDevice(id: string) {
    setDeviceId(id)
    const next = await window.api.settings.set({ audioInputDeviceId: id })
    setSettings(next)
  }

  async function persistChannel(c: number) {
    setChannel(c)
    const next = await window.api.settings.set({ audioInputChannel: c })
    setSettings(next)
  }

  async function start() {
    setError(null)
    const reader = new LtcReader()
    readerRef.current = reader
    await reader.start(
      { deviceId: deviceId || undefined, channel },
      {
        onTimecode: (tc) => setTimecode(tc, 'ltc'),
        onLevel: setLevel,
        onChannelCount: setChannelCount,
        onError: (e) => {
          setError(e.message)
          setListening(false)
        },
      },
    )
    setListening(true)
  }

  async function stop() {
    await readerRef.current?.stop()
    readerRef.current = null
    setListening(false)
    setLevel(0)
    if (tcSource === 'ltc') clearTimecode()
  }

  // If the user changes device or channel while listening, hot-restart so
  // the change actually takes effect.
  async function changeDevice(id: string) {
    await persistDevice(id)
    if (listening) {
      await stop()
      await new Promise((r) => setTimeout(r, 50))
      await start()
    }
  }
  async function changeChannel(c: number) {
    await persistChannel(c)
    if (listening) {
      await stop()
      await new Promise((r) => setTimeout(r, 50))
      await start()
    }
  }

  const stale = tcSource === 'ltc' && Date.now() - tcLastAt > 500
  const display = currentTc || '--:--:--:--'
  const levelPct = Math.min(100, Math.round(level * 300))
  const selectedLabel =
    devices.find((d) => d.deviceId === deviceId)?.label ||
    (deviceId ? `Input ${deviceId.slice(0, 6)}` : '—')

  return (
    <div>
      <div className={`tc-display ${stale ? 'stale' : ''}`}>{display}</div>
      <div className="tc-sub">
        Source:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {tcSource === 'none'
            ? '—'
            : tcSource === 'ltc'
              ? `${selectedLabel} · ch ${channel}`
              : 'Simulator'}
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
          <strong style={{ fontSize: 13 }}>Timecode Input (LTC)</strong>
          <span style={{ color: 'var(--muted)', fontSize: 11 }}>
            {listening ? 'Decoding…' : 'Idle'}
          </span>
        </div>

        <div className="field">
          <label>Input Device</label>
          <select
            value={deviceId}
            onChange={(e) => changeDevice(e.target.value)}
          >
            {devices.length === 0 && <option value="">No inputs found</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Input Channel
            {listening && channelCount > 0 && (
              <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                · {channelCount} channel{channelCount === 1 ? '' : 's'} detected
              </span>
            )}
          </label>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 1fr)',
              gap: 4,
            }}
          >
            {Array.from(
              { length: Math.max(8, channelCount) },
              (_, i) => i + 1,
            ).map((c) => {
              const unavailable = listening && c > channelCount
              return (
                <button
                  key={c}
                  onClick={() => changeChannel(c)}
                  disabled={unavailable}
                  className={c === channel ? 'primary' : ''}
                  style={{
                    padding: '6px 0',
                    fontSize: 11,
                    fontFamily: 'ui-monospace, monospace',
                    opacity: unavailable ? 0.3 : 1,
                  }}
                  title={
                    unavailable
                      ? `Device only has ${channelCount} channels`
                      : `Use channel ${c}`
                  }
                >
                  {c}
                </button>
              )
            })}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
            Tip: for a multi-channel interface (e.g. MOTU, Focusrite), pick the
            physical input the LTC feed is on. The selected channel persists
            per workspace.
          </div>
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
