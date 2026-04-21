import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import { formatBytesHex } from '../../../shared/midi'

function fmtTime(ms: number) {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

type DirFilter = 'all' | 'out' | 'in'

export function MidiMonitor() {
  const log = useApp((s) => s.log)
  const settings = useApp((s) => s.settings)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [viewChannel, setViewChannel] = useState<number | 'all'>('all')
  const bottomRef = useRef<HTMLDivElement>(null)

  const rxChannels = settings?.rxChannels ?? []

  const filtered = useMemo(() => {
    return log.filter((e) => {
      if (dirFilter !== 'all' && e.direction !== dirFilter) return false
      if (viewChannel !== 'all' && e.channel !== viewChannel) return false
      return true
    })
  }, [log, dirFilter, viewChannel])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [filtered])

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
        {rxChannels.length > 0 && (
          <span
            style={{
              color: 'var(--warn)',
              marginLeft: 'auto',
              fontSize: 10,
            }}
            title="Incoming messages on other channels are being dropped at the source. Clear the Listen filter in the Input panel to see everything."
          >
            RX filter: ch {rxChannels.sort((a, b) => a - b).join(',')}
          </span>
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
