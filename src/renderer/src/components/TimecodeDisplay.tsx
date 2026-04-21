import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import type { AudioDeviceInfo, AudioStatus } from '../../../shared/types'

export function TimecodeDisplay() {
  const currentTc = useApp((s) => s.currentTc)
  const tcSource = useApp((s) => s.tcSource)
  const tcLastAt = useApp((s) => s.tcLastAt)
  const setTimecode = useApp((s) => s.setTimecode)
  const clearTimecode = useApp((s) => s.clearTimecode)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)

  const [devices, setDevices] = useState<AudioDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<number | ''>('')
  const [channel, setChannel] = useState<number>(1)
  const [status, setStatus] = useState<AudioStatus | null>(null)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [warning, setWarning] = useState<{
    text: string
    at: number
  } | null>(null)
  const [, setTick] = useState(0)

  // Keep the "stale" badge repainting.
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(i)
  }, [])

  useEffect(() => {
    const offFrame = window.api.onLtcFrame((f) => setTimecode(f.tc, 'ltc'))
    const offLevel = window.api.onLtcLevel((rms) => setLevel(rms))
    const offStatus = window.api.onAudioStatus((s) => setStatus(s))
    const offWarn = window.api.onAudioWarning((w) =>
      setWarning({ text: w.message, at: Date.now() }),
    )
    void window.api.audio.status().then(setStatus)
    return () => {
      offFrame()
      offLevel()
      offStatus()
      offWarn()
    }
  }, [setTimecode])

  // Fade stale warnings out after a few seconds.
  useEffect(() => {
    if (!warning) return
    const id = setTimeout(() => setWarning(null), 4000)
    return () => clearTimeout(id)
  }, [warning])

  const refreshDevices = useRef<() => Promise<void>>(async () => undefined)
  refreshDevices.current = async () => {
    setRefreshing(true)
    try {
      const list = await window.api.audio.listDevices()
      setDevices(list)
    } finally {
      setRefreshing(false)
    }
  }

  // Initial device enumeration.
  useEffect(() => {
    void refreshDevices.current()
  }, [])

  // Apply persisted settings. Resolve by id first; fall back to name match
  // so drivers that re-number on reboot still line up.
  useEffect(() => {
    if (!settings || devices.length === 0) return
    if (deviceId !== '') return

    const byId = devices.find((d) => d.id === settings.audioInputDeviceId)
    const byName =
      !byId && settings.audioInputDeviceName
        ? devices.find((d) => d.name === settings.audioInputDeviceName)
        : undefined
    const picked = byId ?? byName ?? devices.find((d) => d.isDefaultInput) ?? devices[0]
    if (picked) setDeviceId(picked.id)

    if (settings.audioInputChannel) setChannel(settings.audioInputChannel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, devices])

  const selected = useMemo(
    () => (deviceId === '' ? null : devices.find((d) => d.id === deviceId) ?? null),
    [devices, deviceId],
  )

  // Clamp the channel into the selected device's range.
  useEffect(() => {
    if (!selected) return
    if (channel > selected.inputChannels) setChannel(1)
  }, [selected, channel])

  const listening = !!status?.running

  async function persistDevice(dev: AudioDeviceInfo) {
    const next = await window.api.settings.set({
      audioInputDeviceId: dev.id,
      audioInputDeviceName: dev.name,
    })
    setSettings(next)
  }
  async function persistChannel(c: number) {
    const next = await window.api.settings.set({ audioInputChannel: c })
    setSettings(next)
  }

  async function start() {
    if (!selected) {
      setError('Pick an input device first')
      return
    }
    setError(null)
    try {
      const s = await window.api.audio.start({
        deviceId: selected.id,
        channel,
      })
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function stop() {
    try {
      const s = await window.api.audio.stop()
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLevel(0)
    if (tcSource === 'ltc') clearTimecode()
  }

  async function resync() {
    try {
      const s = await window.api.audio.resync()
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function changeDevice(id: number) {
    const dev = devices.find((d) => d.id === id)
    if (!dev) return
    setDeviceId(id)
    await persistDevice(dev)
    const safeCh = Math.min(channel, dev.inputChannels) || 1
    if (safeCh !== channel) {
      setChannel(safeCh)
      await persistChannel(safeCh)
    }
    if (listening) {
      await stop()
      await new Promise((r) => setTimeout(r, 50))
      await start()
    }
  }

  async function changeChannel(c: number) {
    setChannel(c)
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
  const selectedLabel = selected?.name ?? '—'

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
          <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
            · signal lost
          </span>
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
            {listening
              ? `Decoding · ${status?.sampleRate ?? 0} Hz`
              : refreshing
                ? 'Scanning…'
                : 'Idle'}
          </span>
        </div>

        <div className="field">
          <label
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>Input Device</span>
            <button
              onClick={() => void refreshDevices.current()}
              disabled={listening || refreshing}
              style={{ padding: '2px 8px', fontSize: 10 }}
              title="Rescan audio devices"
            >
              Rescan
            </button>
          </label>
          <select
            value={deviceId === '' ? '' : String(deviceId)}
            onChange={(e) => changeDevice(Number(e.target.value))}
          >
            {devices.length === 0 && <option value="">No inputs found</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.inputChannels} ch
                {d.isDefaultInput ? ' · default' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Input Channel
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
              {selected
                ? `· 1 – ${selected.inputChannels} available`
                : ''}
            </span>
          </label>
          {selected && selected.inputChannels === 1 ? (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                color: 'var(--muted)',
                fontSize: 12,
              }}
            >
              This device exposes a single mono input — nothing to pick.
            </div>
          ) : (
            <select
              value={channel}
              onChange={(e) => changeChannel(Number(e.target.value))}
              disabled={!selected}
            >
              {selected &&
                Array.from({ length: selected.inputChannels }, (_, i) => i + 1).map(
                  (c) => (
                    <option key={c} value={c}>
                      Channel {c}
                    </option>
                  ),
                )}
            </select>
          )}
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
            Native multi-channel capture via CoreAudio/ASIO — supports any
            number of inputs (Dante, MADI, aggregates, etc.). Saved per
            workspace.
          </div>
        </div>

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

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!listening ? (
            <button className="primary" onClick={start} disabled={!selected}>
              Start Listening
            </button>
          ) : (
            <>
              <button className="danger" onClick={stop}>
                Stop Listening
              </button>
              <button
                onClick={resync}
                title="Force the LTC decoder to re-acquire lock without stopping the audio stream"
                style={{ padding: '6px 10px' }}
              >
                Resync
              </button>
              {(status?.resyncs ?? 0) + (status?.streamRestarts ?? 0) > 0 && (
                <span
                  style={{ color: 'var(--muted)', fontSize: 11 }}
                  title="Automatic recoveries performed since this stream started"
                >
                  · auto-recoveries:{' '}
                  {(status?.resyncs ?? 0) + (status?.streamRestarts ?? 0)}
                </span>
              )}
              {(status?.rejectedFrames ?? 0) > 0 && (
                <span
                  style={{ color: 'var(--muted)', fontSize: 11 }}
                  title="Frames rejected by the decoder's two-frame corroboration filter — almost always bit errors that would have produced a spurious timecode"
                >
                  · rejected: {status?.rejectedFrames}
                </span>
              )}
            </>
          )}
        </div>
        {warning && (
          <div
            style={{
              color: 'var(--warn)',
              marginTop: 8,
              fontSize: 11,
              opacity: 0.9,
            }}
          >
            {warning.text}
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--bad)', marginTop: 8, fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
