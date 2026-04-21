import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import type { Cue } from '../../../shared/types'
import {
  buildCueBytes,
  bytesToLabel,
  parseTimecode,
  timecodeToMs,
} from '../../../shared/midi'

function newCue(): Cue {
  return {
    id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'dliveScene',
    name: 'New cue',
    timecode: '00:00:00:00',
    enabled: true,
    channel: 1,
    scene: 1,
  }
}

export function CueList() {
  const cues = useApp((s) => s.cues)
  const setCues = useApp((s) => s.setCues)
  const currentTc = useApp((s) => s.currentTc)
  const tcSource = useApp((s) => s.tcSource)
  const settings = useApp((s) => s.settings)
  const lastFiredCueId = useApp((s) => s.lastFiredCueId)
  const setLastFired = useApp((s) => s.setLastFired)
  const [dirty, setDirty] = useState(false)

  // Track fired cues in a ref so we don't double-fire.
  const firedRef = useRef<Set<string>>(new Set())
  const prevTcMsRef = useRef<number>(-1)

  const fps = settings?.frameRate ?? 30
  const preRollMs = settings?.preRollMs ?? 0

  // Precompute sorted cues with ms.
  const sortedCues = useMemo(() => {
    return [...cues]
      .map((c) => {
        const tc = parseTimecode(c.timecode)
        return {
          cue: c,
          ms: tc ? timecodeToMs(tc, fps) : Number.POSITIVE_INFINITY,
        }
      })
      .sort((a, b) => a.ms - b.ms)
  }, [cues, fps])

  // Fire cues when currentTc crosses them.
  useEffect(() => {
    const tc = parseTimecode(currentTc)
    if (!tc) {
      prevTcMsRef.current = -1
      return
    }
    const nowMs = timecodeToMs(tc, fps)

    // If user jumped backward (seek), clear the fired set so cues can
    // retrigger.
    if (nowMs < prevTcMsRef.current - 1000) {
      firedRef.current.clear()
    }

    for (const { cue, ms } of sortedCues) {
      if (!cue.enabled) continue
      if (firedRef.current.has(cue.id)) continue
      if (ms - preRollMs <= nowMs) {
        fireCue(cue)
        firedRef.current.add(cue.id)
        setLastFired(cue.id)
      }
    }
    prevTcMsRef.current = nowMs
    // We deliberately don't depend on lastFiredCueId to avoid re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTc, fps, preRollMs, sortedCues])

  // Clear fired when timecode source becomes idle.
  useEffect(() => {
    if (tcSource === 'none') {
      firedRef.current.clear()
      prevTcMsRef.current = -1
    }
  }, [tcSource])

  async function persist(next: Cue[]) {
    setCues(next)
    setDirty(true)
    await window.api.cues.save(next)
    setDirty(false)
  }

  function update(id: string, patch: Partial<Cue>) {
    const next = cues.map((c) => (c.id === id ? ({ ...c, ...patch } as Cue) : c))
    void persist(next)
  }

  function add() {
    void persist([...cues, newCue()])
  }

  function remove(id: string) {
    firedRef.current.delete(id)
    void persist(cues.filter((c) => c.id !== id))
  }

  function testFire(c: Cue) {
    fireCue(c)
    setLastFired(c.id)
  }

  function resetFired() {
    firedRef.current.clear()
    setLastFired(null)
  }

  return (
    <div
      className="panel"
      style={{
        borderRight: 'none',
        borderLeft: 'none',
        borderTop: '1px solid var(--border)',
        flex: 1,
        minHeight: 0,
      }}
    >
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>Cue List</span>
        <span
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textTransform: 'none',
            letterSpacing: 0,
            color: dirty ? 'var(--warn)' : 'var(--muted)',
            fontSize: 11,
          }}
        >
          {dirty ? 'saving…' : `${cues.length} cue${cues.length === 1 ? '' : 's'} · ${fps} fps`}
          <button
            className="primary"
            onClick={add}
            style={{ padding: '4px 10px', fontSize: 11 }}
          >
            + Add cue
          </button>
          <button
            onClick={resetFired}
            title="Re-arm all cues"
            style={{ padding: '4px 10px', fontSize: 11 }}
          >
            Reset fired
          </button>
        </span>
      </h2>
      <div className="panel-body">
        <table className="cues">
          <thead>
            <tr>
              <th style={{ width: 36 }}>On</th>
              <th style={{ width: 110 }}>Timecode</th>
              <th>Name</th>
              <th style={{ width: 130 }}>Type</th>
              <th style={{ width: 64 }} title="MIDI output channel (1-16)">
                Out Ch
              </th>
              <th style={{ width: 90 }}>Value</th>
              <th style={{ width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {cues.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: 'var(--muted)', padding: 20, textAlign: 'center' }}>
                  No cues yet. Click “Add cue” to create your first one.
                </td>
              </tr>
            )}
            {cues.map((c) => {
              const isFired = firedRef.current.has(c.id)
              const isArmed = lastFiredCueId === c.id
              return (
                <tr
                  key={c.id}
                  className={isArmed ? 'fired' : isFired ? 'armed' : ''}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => update(c.id, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      value={c.timecode}
                      onChange={(e) => update(c.id, { timecode: e.target.value })}
                      placeholder="00:00:00:00"
                      style={{
                        fontFamily: 'ui-monospace, monospace',
                        color: parseTimecode(c.timecode) ? 'inherit' : 'var(--bad)',
                      }}
                    />
                  </td>
                  <td>
                    <input
                      value={c.name}
                      onChange={(e) => update(c.id, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={c.type}
                      onChange={(e) => {
                        const t = e.target.value as Cue['type']
                        if (t === 'dliveScene') {
                          update(c.id, {
                            type: 'dliveScene',
                            scene: (c as Extract<Cue, { type: 'dliveScene' }>).scene ?? 1,
                          } as Partial<Cue>)
                        } else {
                          update(c.id, {
                            type: 'programChange',
                            program: 0,
                          } as Partial<Cue>)
                        }
                      }}
                    >
                      <option value="dliveScene">dLive Scene</option>
                      <option value="programChange">Program Change</option>
                    </select>
                  </td>
                  <td className="ch-cell">
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={c.channel}
                      onChange={(e) =>
                        update(c.id, { channel: parseInt(e.target.value, 10) || 1 })
                      }
                      title="MIDI output channel this cue fires on"
                    />
                  </td>
                  <td>
                    {c.type === 'dliveScene' ? (
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={c.scene}
                        onChange={(e) =>
                          update(c.id, { scene: parseInt(e.target.value, 10) || 1 })
                        }
                      />
                    ) : (
                      <input
                        type="number"
                        min={0}
                        max={127}
                        value={c.program}
                        onChange={(e) =>
                          update(c.id, { program: parseInt(e.target.value, 10) || 0 })
                        }
                      />
                    )}
                  </td>
                  <td className="cue-actions">
                    <button className="icon-btn" onClick={() => testFire(c)}>
                      Fire
                    </button>
                    <button className="icon-btn danger" onClick={() => remove(c.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

async function fireCue(cue: Cue) {
  const bytes = buildCueBytes(cue)
  const label = `${cue.name} → ${bytesToLabel(bytes)}`
  await window.api.dlive.sendBytes(bytes, label)
}
