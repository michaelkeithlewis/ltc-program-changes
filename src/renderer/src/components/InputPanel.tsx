import { useEffect, useState } from 'react'
import { useApp } from '../store'

const CHANNELS = Array.from({ length: 16 }, (_, i) => i + 1)

/**
 * "MIDI Input" panel: pick which channels the app accepts from the dLive,
 * and show the most recent channel-voice message seen on each channel.
 */
export function InputPanel() {
  const settings = useApp((s) => s.settings)
  const received = useApp((s) => s.received)
  const setSettings = useApp((s) => s.setSettings)
  const [, setTick] = useState(0)

  // Repaint once a second so the "age" badges stay fresh.
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(h)
  }, [])

  const rx = settings?.rxChannels ?? []
  const allMode = rx.length === 0

  async function toggleChannel(ch: number) {
    if (!settings) return
    let next: number[]
    if (allMode) {
      // First click in all-mode means: start selecting specific channels.
      next = [ch]
    } else if (rx.includes(ch)) {
      next = rx.filter((c) => c !== ch)
    } else {
      next = [...rx, ch].sort((a, b) => a - b)
    }
    const merged = await window.api.settings.set({ rxChannels: next })
    setSettings(merged)
  }

  async function selectAll() {
    if (!settings) return
    const merged = await window.api.settings.set({ rxChannels: [] })
    setSettings(merged)
  }

  async function selectNone() {
    if (!settings) return
    const merged = await window.api.settings.set({ rxChannels: [-1] })
    setSettings(merged)
    // -1 can never match a real channel (1..16). This effectively mutes
    // all incoming channel-voice messages while keeping non-channel
    // messages (realtime, sysex) visible.
  }

  const now = Date.now()

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border)',
        padding: 16,
        background: 'var(--bg-2)',
      }}
    >
      <div className="section-header">
        <h3>MIDI Input</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            style={{ padding: '3px 8px', fontSize: 11 }}
            onClick={selectAll}
            disabled={allMode}
            title="Listen on all channels"
          >
            All
          </button>
          <button
            style={{ padding: '3px 8px', fontSize: 11 }}
            onClick={selectNone}
            title="Mute incoming channel messages"
          >
            None
          </button>
        </div>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 8 }}>
        Click a channel to arm/disarm listening. Armed channels light up when
        MIDI arrives.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, 1fr)',
          gap: 6,
        }}
      >
        {CHANNELS.map((ch) => {
          const listening = allMode || rx.includes(ch)
          const last = received.byChannel[ch]
          const age = last ? now - last.at : null
          const recent = age !== null && age < 800
          return (
            <button
              key={ch}
              onClick={() => toggleChannel(ch)}
              className={listening ? 'primary' : ''}
              style={{
                position: 'relative',
                padding: '10px 4px',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 13,
                textAlign: 'center',
                opacity: listening ? 1 : 0.4,
                borderColor: recent && listening ? 'var(--good)' : undefined,
                boxShadow: recent && listening
                  ? '0 0 0 2px rgba(61, 220, 132, 0.35)'
                  : undefined,
                transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
              }}
              title={
                last
                  ? `${last.label}  (${Math.round((age ?? 0) / 100) / 10}s ago)`
                  : 'No messages received on this channel yet'
              }
            >
              <div style={{ fontWeight: 600 }}>ch{ch}</div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--muted)',
                  marginTop: 2,
                  minHeight: 12,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {last?.kind === 'programChange'
                  ? `PC ${received.lastProgramChange[ch]?.program ?? ''}`
                  : last?.kind ?? '—'}
              </div>
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>
        {allMode
          ? 'Listening on all 16 channels.'
          : rx.length === 0 || (rx.length === 1 && rx[0] === -1)
            ? 'Muted — no incoming channel messages will be processed.'
            : `Listening only on channels: ${rx.filter((c) => c > 0).join(', ')}`}
      </div>
    </div>
  )
}
