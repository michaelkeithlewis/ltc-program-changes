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
  const setMonitorVisible = useApp((s) => s.setMonitorVisible)
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
        <span>MIDI Monitor</span>
        <span
          className="chip idle"
          style={{ marginLeft: 4 }}
          title={`${filtered.length} of ${log.length} log entries match the current filter`}
        >
          {filtered.length}/{log.length}
        </span>
        <button
          className="panel-close"
          style={{ marginLeft: 'auto' }}
          onClick={() => setMonitorVisible(false)}
          title="Hide MIDI Monitor"
          aria-label="Hide MIDI Monitor"
        >
          ✕
        </button>
      </h2>
      <div className="monitor-toolbar">
        <div className="seg" role="group" aria-label="Direction filter">
          {(['all', 'out', 'in'] as DirFilter[]).map((d) => (
            <button
              key={d}
              className={dirFilter === d ? 'is-active' : ''}
              onClick={() => setDirFilter(d)}
            >
              {d}
            </button>
          ))}
        </div>
        <label className="inline-field" title="Filter by MIDI channel">
          <span className="label">Ch</span>
          <select
            value={viewChannel === 'all' ? 'all' : String(viewChannel)}
            onChange={(e) =>
              setViewChannel(
                e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10),
              )
            }
          >
            <option value="all">all</option>
            {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label
          className={`toggle-chip ${hideNoisy ? 'is-on' : ''}`}
          title="Hide NRPN / CC / pitch-bend / aftertouch traffic. dLive emits thousands of these per scene recall — hiding them keeps the monitor readable."
        >
          <input
            type="checkbox"
            checked={hideNoisy}
            onChange={(e) => setHideNoisy(e.target.checked)}
          />
          <span>Hide noise</span>
          {hiddenCount > 0 && hideNoisy && (
            <span className="count">{hiddenCount}</span>
          )}
        </label>
        {rxChannels.length > 0 && (
          <button
            className="rx-clear"
            onClick={async () => {
              await window.api.settings.set({ rxChannels: [] })
            }}
            title="Clear the incoming-channel filter"
          >
            RX filter · clear
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
            <div className="dir">{e.direction === 'out' ? '→ OUT' : '← IN'}</div>
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
