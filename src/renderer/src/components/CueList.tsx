import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import type { Cue } from '../../../shared/types'
import {
  buildCueBytes,
  bytesToLabel,
  parseTimecode,
  timecodeToMs,
} from '../../../shared/midi'

function newCue(timecode: string, channel: number): Cue {
  return {
    id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'programChange',
    name: 'New cue',
    timecode,
    enabled: true,
    channel,
    program: 0,
  }
}

/** Hard cap on cues that may fire in a single effect tick — pure defensive
 * measure so a malformed cue list can never flood the dLive bus. */
const FIRE_CAP_PER_TICK = 16

/** Save debounce: we keep zustand state in sync instantly (for a snappy
 * UI), but defer the IPC + disk write so rapid keystrokes in a cue row
 * don't queue N writes. */
const SAVE_DEBOUNCE_MS = 250

/**
 * If a single playhead tick advances by more than this, we treat it as a
 * seek, not a continuous playback advance. The memo moves to the new
 * position but cues between old and new are NOT retroactively fired.
 *
 * Set generously at 2 s — a real show's playhead advances by at most a
 * few frames (tens of ms) per tick, so anything this large is either
 * a user-initiated seek on the LTC source or a decoder glitch that
 * snuck past the corroboration filter. Either way, firing every cue
 * between here and there is the wrong behaviour.
 */
const SEEK_JUMP_MS = 2000

export function CueList() {
  const cues = useApp((s) => s.cues)
  const setCues = useApp((s) => s.setCues)
  const currentTc = useApp((s) => s.currentTc)
  const tcSource = useApp((s) => s.tcSource)
  const settings = useApp((s) => s.settings)
  const lastFiredCueId = useApp((s) => s.lastFiredCueId)
  const setLastFired = useApp((s) => s.setLastFired)
  const [dirty, setDirty] = useState(false)

  /**
   * Last-known playhead in ms. Cues fire only when the playhead *crosses*
   * them going forward (prev < trigger <= now), which neatly avoids firing
   * past cues when they're added mid-session and avoids re-firing on
   * no-op ticks.
   */
  const prevTcMsRef = useRef<number | null>(null)

  /**
   * Debounced IPC write. The component always updates zustand immediately
   * so the UI is snappy, but the actual disk write is coalesced. We also
   * flush on unmount so no edit is ever lost.
   */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<Cue[] | null>(null)

  const fps = settings?.frameRate ?? 30
  const preRollMs = settings?.preRollMs ?? 0

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

  useEffect(() => {
    const tc = parseTimecode(currentTc)
    if (!tc) {
      prevTcMsRef.current = null
      return
    }
    const nowMs = timecodeToMs(tc, fps)
    const prev = prevTcMsRef.current

    if (prev !== null) {
      const delta = nowMs - prev
      // Massive forward jump = seek or a single-sample bogus TC that
      // slipped past the decoder's corroboration filter. Move the memo
      // but don't fire everything in between — the user almost certainly
      // didn't want to. The cue that aligns with the new position will
      // still fire on the very next tick.
      if (delta > SEEK_JUMP_MS) {
        prevTcMsRef.current = nowMs
        return
      }
      let fired = 0
      for (const { cue, ms } of sortedCues) {
        if (!cue.enabled) continue
        const trigger = ms - preRollMs
        if (prev < trigger && trigger <= nowMs) {
          fireCue(cue)
          setLastFired(cue.id)
          if (++fired >= FIRE_CAP_PER_TICK) {
            console.warn(
              `CueList: fire cap hit (${FIRE_CAP_PER_TICK}), skipping remaining cues for this tick`,
            )
            break
          }
        }
      }
    }

    prevTcMsRef.current = nowMs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTc, fps, preRollMs, sortedCues])

  useEffect(() => {
    if (tcSource === 'none') prevTcMsRef.current = null
  }, [tcSource])

  const flushSave = useCallback(async () => {
    if (!pendingSaveRef.current) return
    const snapshot = pendingSaveRef.current
    pendingSaveRef.current = null
    try {
      await window.api.cues.save(snapshot)
    } finally {
      setDirty(false)
    }
  }, [])

  const scheduleSave = useCallback(
    (next: Cue[]) => {
      pendingSaveRef.current = next
      setDirty(true)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        void flushSave()
      }, SAVE_DEBOUNCE_MS)
    },
    [flushSave],
  )

  // Flush any outstanding save when unmounting (workspace switch, app close)
  // or when the window is about to close.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      void flushSave()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      void flushSave()
    }
  }, [flushSave])

  /**
   * Any cue-list mutation advances the playhead memo so no cue fires
   * retroactively. If you add or edit a cue such that its trigger lands
   * at or before the current LTC, it stays dormant until the playhead
   * crosses it forward next time. This specifically kills the
   * "adding a cue immediately fires PC 0" race: the click-handler
   * captures `currentTc` at render time, but by the time the cue-list
   * effect re-runs, the playhead may have advanced past the prior
   * memo value.
   */
  function armAfterEdit() {
    const tc = parseTimecode(currentTc)
    if (!tc) return
    const nowMs = timecodeToMs(tc, fps)
    const prev = prevTcMsRef.current ?? Number.NEGATIVE_INFINITY
    prevTcMsRef.current = Math.max(prev, nowMs)
  }

  function persist(next: Cue[]) {
    armAfterEdit()
    setCues(next)
    scheduleSave(next)
  }

  function update(id: string, patch: Partial<Cue>) {
    const next = cues.map((c) => (c.id === id ? { ...c, ...patch } : c))
    void persist(next)
  }

  function add() {
    // Default timecode: the live playhead if there is one, otherwise where
    // we left off (latest existing cue's TC, nudged one frame), otherwise 0.
    let seed = currentTc
    if (!seed) {
      const latest = [...cues]
        .map((c) => parseTimecode(c.timecode))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort(
          (a, b) =>
            timecodeToMs(b, fps) - timecodeToMs(a, fps),
        )[0]
      if (latest) {
        seed = `${String(latest.hours).padStart(2, '0')}:${String(latest.minutes).padStart(2, '0')}:${String(latest.seconds + 1).padStart(2, '0')}:00`
      }
    }
    const lastCh = cues[cues.length - 1]?.channel ?? 1
    const created = newCue(seed || '00:00:00:00', lastCh)
    void persist([...cues, created])
  }

  function capture(id: string) {
    if (!currentTc) return
    update(id, { timecode: currentTc })
  }

  function remove(id: string) {
    void persist(cues.filter((c) => c.id !== id))
  }

  function testFire(c: Cue) {
    fireCue(c)
    setLastFired(c.id)
  }

  function resetFired() {
    prevTcMsRef.current = null
    setLastFired(null)
  }

  const hasLiveTc = !!parseTimecode(currentTc)

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
          {dirty
            ? 'saving…'
            : `${cues.length} cue${cues.length === 1 ? '' : 's'} · ${fps} fps`}
          <button
            className="primary"
            onClick={add}
            style={{ padding: '4px 10px', fontSize: 11 }}
            title={
              hasLiveTc
                ? `Create a new cue at ${currentTc}`
                : 'Create a new cue (no live timecode detected yet)'
            }
          >
            + Add cue{hasLiveTc ? ` @ ${currentTc}` : ''}
          </button>
          <button
            onClick={resetFired}
            title="Re-arm: forget the last playhead position so cues can fire again"
            style={{ padding: '4px 10px', fontSize: 11 }}
          >
            Re-arm
          </button>
        </span>
      </h2>
      <div className="panel-body">
        <table className="cues">
          <thead>
            <tr>
              <th style={{ width: 36 }}>On</th>
              <th style={{ width: 140 }}>Timecode</th>
              <th>Name</th>
              <th style={{ width: 64 }} title="MIDI output channel (1-16)">
                Out Ch
              </th>
              <th style={{ width: 80 }} title="Program Change number (0-127)">
                PC #
              </th>
              <th style={{ width: 140 }}></th>
            </tr>
          </thead>
          <tbody>
            {cues.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    color: 'var(--muted)',
                    padding: 24,
                    textAlign: 'center',
                  }}
                >
                  No cues yet. Click <strong>+ Add cue</strong> — if LTC is
                  decoding, the current timecode is captured automatically.
                </td>
              </tr>
            )}
            {cues.map((c) => {
              const isArmed = lastFiredCueId === c.id
              const tcValid = !!parseTimecode(c.timecode)
              return (
                <tr key={c.id} className={isArmed ? 'fired' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) =>
                        update(c.id, { enabled: e.target.checked })
                      }
                    />
                  </td>
                  <td>
                    <div
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <input
                        value={c.timecode}
                        onChange={(e) =>
                          update(c.id, { timecode: e.target.value })
                        }
                        placeholder="00:00:00:00"
                        style={{
                          fontFamily: 'ui-monospace, monospace',
                          color: tcValid ? 'inherit' : 'var(--bad)',
                        }}
                      />
                      <button
                        className="icon-btn"
                        onClick={() => capture(c.id)}
                        disabled={!hasLiveTc}
                        title={
                          hasLiveTc
                            ? `Capture ${currentTc} into this cue`
                            : 'No live timecode to capture'
                        }
                        style={{ flexShrink: 0, padding: '4px 8px' }}
                      >
                        ⦿
                      </button>
                    </div>
                  </td>
                  <td>
                    <input
                      value={c.name}
                      onChange={(e) => update(c.id, { name: e.target.value })}
                    />
                  </td>
                  <td className="ch-cell">
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={c.channel}
                      onChange={(e) =>
                        update(c.id, {
                          channel: parseInt(e.target.value, 10) || 1,
                        })
                      }
                      title="MIDI output channel this cue fires on"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={127}
                      value={c.program}
                      onChange={(e) =>
                        update(c.id, {
                          program: parseInt(e.target.value, 10) || 0,
                        })
                      }
                      title="Program Change number (0-127). On dLive this is the scene number minus one (scene 1 = PC 0)."
                    />
                  </td>
                  <td className="cue-actions">
                    <button
                      className="icon-btn"
                      onClick={() => testFire(c)}
                      title="Send this cue's MIDI now"
                    >
                      Fire
                    </button>
                    <button
                      className="icon-btn danger"
                      onClick={() => remove(c.id)}
                      title="Delete cue"
                    >
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
