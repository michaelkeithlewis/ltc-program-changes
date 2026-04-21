import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import { formatBytesHex } from '../../../shared/midi'

function fmtTime(ms: number) {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

type DirFilter = 'all' | 'out' | 'in'

/**
 * Message kinds that are pure noise for this application (we only care
 * about PC and real user-scale events). dLive in particular fires
 * thousands of these per scene recall, so hiding them by default keeps
 * the monitor useful and keeps the DOM small.
 */
const NOISY_KINDS = new Set<string>(['nrpn', 'cc', 'pitchBend', 'channelPressure', 'polyPressure'])

export function MidiMonitor() {
  const log = useApp((s) => s.log)
  const settings = useApp((s) => s.settings)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [viewChannel, setViewChannel] = useState<number | 'all'>('all')
  const [hideNoisy, setHideNoisy] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const rxChannels = settings?.rxChannels ?? []

  const filtered = useMemo(() => {
    return log.filter((e) => {
      if (dirFilter !== 'all' && e.direction !== dirFilter) return false
      if (viewChannel !== 'all' && e.channel !== viewChannel) return false
      if (hideNoisy && e.kind && NOISY_KINDS.has(e.kind)) return false
      return true
    })
  }, [log, dirFilter, viewChannel, hideNoisy])

  // Auto-scroll, but rate-limited. A burst of N log entries used to fire
  // N scrollIntoView calls back-to-back; now we do one per animation frame
  // at most.
  useEffect(() => {
    let raf = 0
    raf = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    })
    return () => cancelAnimationFrame(raf)
  }, [filtered])

  const hiddenCount = log.length - filtered.length

  return (
    <div className="panel">
      <h2>
        MIDI Monitor
        <span
          style={{
            float: 'right',
            textTransform: 'none',
            letterSpacing: 0,
            color: 'var(--muted)',
            fontSize: 11,
          }}
        >
          {filtered.length}/{log.length}
        </span>
      </h2>
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'out', 'in'] as DirFilter[]).map((d) => (
            <button
              key={d}
              className={dirFilter === d ? 'primary' : ''}
              style={{ padding: '3px 8px', fontSize: 11 }}
              onClick={() => setDirFilter(d)}
            >
              {d.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ color: 'var(--muted)', marginLeft: 6 }}>View ch:</div>
        <select
          value={viewChannel === 'all' ? 'all' : String(viewChannel)}
          onChange={(e) =>
            setViewChannel(
              e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10),
            )
          }
          style={{ padding: '3px 8px', fontSize: 11 }}
        >
          <option value="all">all</option>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            color: 'var(--muted)',
            marginLeft: 6,
            cursor: 'pointer',
          }}
          title="Hide NRPN / CC / pitch-bend / aftertouch traffic. dLive emits thousands of these per scene recall — hiding them keeps the monitor readable."
        >
          <input
            type="checkbox"
            checked={hideNoisy}
            onChange={(e) => setHideNoisy(e.target.checked)}
          />
          Hide NRPN/CC
          {hiddenCount > 0 && hideNoisy && (
            <span style={{ color: 'var(--warn)' }}>· {hiddenCount} hidden</span>
          )}
        </label>
        {rxChannels.length > 0 && (
          <button
            onClick={async () => {
              await window.api.settings.set({ rxChannels: [] })
            }}
            style={{
              marginLeft: 'auto',
              padding: '3px 8px',
              fontSize: 10,
              color: 'var(--warn)',
              borderColor: 'var(--warn)',
              background: 'transparent',
            }}
            title="Clear the incoming-channel filter"
          >
            RX filter active · clear
          </button>
        )}
      </div>
      <div className="panel-body monitor">
        {filtered.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            No messages match the current filter.
          </div>
        )}
        {filtered.map((e) => (
          <div key={e.id} className={`monitor-row ${e.direction}`}>
            <div className="tag">{fmtTime(e.at)}</div>
            <div className="dir">{e.direction === 'out' ? '▶ OUT' : '◀ IN'}</div>
            <div>
              {e.label}
              <span className="hex">{formatBytesHex(e.bytes)}</span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
