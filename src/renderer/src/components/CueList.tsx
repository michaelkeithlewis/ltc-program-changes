import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import type { Cue } from '../../../shared/types'
import {
  buildCueBytes,
  bytesToLabel,
  parseTimecode,
  timecodeToMs,
} from '../../../shared/midi'
import { buildCueRows, type CueRuntimeState } from '../cueState'

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
 */
const SEEK_JUMP_MS = 2000

/** Human-readable label shown in the state badge for each row. */
const STATE_LABEL: Record<CueRuntimeState, string> = {
  disabled: 'off',
  invalid: 'bad tc',
  idle: '–',
  past: 'past',
  missed: 'missed',
  fired: 'fired',
  next: 'next',
  armed: 'armed',
}

/** Tooltip copy for each state — one short sentence, shown on hover. */
const STATE_TOOLTIP: Record<CueRuntimeState, string> = {
  disabled: 'Cue is disabled and will not fire.',
  invalid: 'Timecode cannot be parsed.',
  idle: 'Waiting for LTC.',
  past: 'Trigger is behind the start of this pass.',
  missed: 'Trigger was crossed but the cue did not fire.',
  fired: 'Cue fired during this pass.',
  next: 'Next cue to fire.',
  armed: 'Upcoming cue.',
}

export function CueList() {
  const cues = useApp((s) => s.cues)
  const setCues = useApp((s) => s.setCues)
  const currentTc = useApp((s) => s.currentTc)
  const tcSource = useApp((s) => s.tcSource)
  const tcAnchorMs = useApp((s) => s.tcAnchorMs)
  const setTcAnchor = useApp((s) => s.setTcAnchor)
  const settings = useApp((s) => s.settings)
  const firedCueIds = useApp((s) => s.firedCueIds)
  const lastFiredCueId = useApp((s) => s.lastFiredCueId)
  const markFired = useApp((s) => s.markFired)
  const clearFiredHistory = useApp((s) => s.clearFiredHistory)
  const [dirty, setDirty] = useState(false)

  /**
   * Last-known playhead in ms. Cues fire only when the playhead *crosses*
   * them going forward (prev < trigger <= now), which neatly avoids firing
   * past cues when they're added mid-session and avoids re-firing on
   * no-op ticks.
   */
  const prevTcMsRef = useRef<number | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<Cue[] | null>(null)

  // --- Selection + drag state ---------------------------------------------
  // Selection is by cue id (survives reorders). `lastAnchorId` is the pivot
  // for shift-click range selection. `dragOver` tracks which row the
  // pointer is currently over during a drag, plus which half (for the
  // insert-above / insert-below indicator). `draggingIds` is the frozen
  // set of cue ids being moved in the current drag session.
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [lastAnchorId, setLastAnchorId] = useState<string | null>(null)
  const [draggingIds, setDraggingIds] = useState<string[] | null>(null)
  const [dragOver, setDragOver] = useState<{
    id: string
    pos: 'before' | 'after'
  } | null>(null)
  // Ref mirror of selected for the global keydown handler (avoids stale
  // closures without having to re-register the listener on every change).
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const cuesRef = useRef(cues)
  cuesRef.current = cues
  const panelRef = useRef<HTMLDivElement | null>(null)

  const fps = settings?.frameRate ?? 30
  const preRollMs = settings?.preRollMs ?? 0

  const currentMs = useMemo(() => {
    const tc = parseTimecode(currentTc)
    return tc ? timecodeToMs(tc, fps) : null
  }, [currentTc, fps])

  const view = useMemo(
    () =>
      buildCueRows({
        cues,
        fps,
        preRollMs,
        currentMs,
        tcAnchorMs,
        firedIds: firedCueIds,
      }),
    [cues, fps, preRollMs, currentMs, tcAnchorMs, firedCueIds],
  )

  // Scheduler + anchor bookkeeping. Runs whenever TC advances.
  useEffect(() => {
    if (currentMs === null) {
      prevTcMsRef.current = null
      return
    }

    // Establish a pass anchor the first time TC is observed (or the first
    // time after it went silent). Without this, cues that sit behind the
    // starting playhead would be flagged `missed` rather than `past`.
    if (tcAnchorMs === null) setTcAnchor(currentMs)

    const prev = prevTcMsRef.current
    if (prev !== null) {
      const delta = currentMs - prev
      // Massive forward jump = seek or a single-sample bogus TC that
      // slipped past the decoder's corroboration filter. Move the memo
      // but don't fire everything in between.
      if (delta > SEEK_JUMP_MS) {
        prevTcMsRef.current = currentMs
        return
      }
      let fired = 0
      for (const { cue, ms } of view.rows) {
        if (!cue.enabled || ms === null) continue
        const trigger = ms - preRollMs
        if (prev < trigger && trigger <= currentMs) {
          fireCue(cue)
          markFired(cue.id)
          if (++fired >= FIRE_CAP_PER_TICK) {
            console.warn(
              `CueList: fire cap hit (${FIRE_CAP_PER_TICK}), skipping remaining cues for this tick`,
            )
            break
          }
        }
      }
    }
    prevTcMsRef.current = currentMs
  }, [currentMs, preRollMs, view.rows, tcAnchorMs, setTcAnchor, markFired])

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
   * crosses it forward next time.
   */
  function armAfterEdit() {
    if (currentMs === null) return
    const prev = prevTcMsRef.current ?? Number.NEGATIVE_INFINITY
    prevTcMsRef.current = Math.max(prev, currentMs)
  }

  function persist(next: Cue[]) {
    armAfterEdit()
    setCues(next)
    scheduleSave(next)
  }

  // --- Selection ----------------------------------------------------------

  /**
   * Click on a row selects it. Shift-click extends from the anchor to the
   * clicked row (inclusive) using array-index order. Cmd/Ctrl-click toggles
   * the clicked row in/out of the current selection. Plain click replaces.
   */
  function handleRowClick(
    id: string,
    e: React.MouseEvent<HTMLElement>,
  ) {
    const multi = e.metaKey || e.ctrlKey
    const range = e.shiftKey
    if (range && lastAnchorId) {
      const a = cues.findIndex((c) => c.id === lastAnchorId)
      const b = cues.findIndex((c) => c.id === id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        const next = new Set(multi ? selected : [])
        for (let i = lo; i <= hi; i++) next.add(cues[i].id)
        setSelected(next)
        return
      }
    }
    if (multi) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
      setLastAnchorId(id)
      return
    }
    setSelected(new Set([id]))
    setLastAnchorId(id)
  }

  /**
   * Move the given cue ids as a group to the slot `dropIndex` in the full
   * cues array (0..cues.length). Preserves the relative order of the moved
   * cues, and interprets `dropIndex` against the array *before* removal so
   * that dropping "just after the last item" lands correctly.
   */
  function reorder(ids: string[], dropIndex: number): Cue[] {
    const moving: Cue[] = []
    const remaining: Cue[] = []
    const idSet = new Set(ids)
    let adjustedDrop = dropIndex
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i]
      if (idSet.has(c.id)) {
        moving.push(c)
        if (i < dropIndex) adjustedDrop -= 1
      } else {
        remaining.push(c)
      }
    }
    if (moving.length === 0) return cues
    // Preserve the order the user has the moving cues in the source array,
    // not the order they were clicked in.
    return [
      ...remaining.slice(0, adjustedDrop),
      ...moving,
      ...remaining.slice(adjustedDrop),
    ]
  }

  /** Nudge the selected cues up or down by one slot (clamped). */
  const nudgeSelection = useCallback(
    (direction: -1 | 1) => {
      const sel = selectedRef.current
      if (sel.size === 0) return
      const list = cuesRef.current
      const indices = list
        .map((c, i) => ({ i, id: c.id }))
        .filter((x) => sel.has(x.id))
        .map((x) => x.i)
      if (indices.length === 0) return
      const min = Math.min(...indices)
      const max = Math.max(...indices)
      if (direction < 0 && min === 0) return
      if (direction > 0 && max === list.length - 1) return
      const targetStart = min + direction
      const ids = indices.map((i) => list[i].id)
      const next = reorder(ids, targetStart)
      void persist(next)
    },
    // `persist` isn't in deps because it's declared inside the component
    // and we're using refs for the reads; keep empty deps to avoid
    // rebinding the window listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Cmd+Up / Cmd+Down (and Ctrl on Win/Linux) nudges the selection up/down
  // one slot. We only react when focus is not in a text input so typing
  // arrow keys in a cue name doesn't jump the row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) {
        return
      }
      if (selectedRef.current.size === 0) return
      e.preventDefault()
      nudgeSelection(e.key === 'ArrowUp' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nudgeSelection])

  // --- Drag & drop --------------------------------------------------------

  function handleDragStart(id: string, e: React.DragEvent<HTMLElement>) {
    // If dragging an unselected row, collapse selection to just that row.
    const ids = selected.has(id) ? Array.from(selected) : [id]
    if (!selected.has(id)) {
      setSelected(new Set([id]))
      setLastAnchorId(id)
    }
    setDraggingIds(ids)
    // Firefox requires some dataTransfer payload for dragstart to fire.
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', ids.join(','))
    } catch {
      // Some browsers throw in dragstart handlers during tests; harmless.
    }
  }

  function handleDragOver(id: string, e: React.DragEvent<HTMLElement>) {
    if (!draggingIds) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const pos: 'before' | 'after' =
      e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    if (dragOver?.id !== id || dragOver?.pos !== pos) {
      setDragOver({ id, pos })
    }
  }

  function handleDrop(id: string, e: React.DragEvent<HTMLElement>) {
    e.preventDefault()
    if (!draggingIds) return
    const targetIndex = cues.findIndex((c) => c.id === id)
    if (targetIndex < 0) {
      setDraggingIds(null)
      setDragOver(null)
      return
    }
    const insertAt =
      dragOver?.id === id && dragOver.pos === 'after'
        ? targetIndex + 1
        : targetIndex
    void persist(reorder(draggingIds, insertAt))
    setDraggingIds(null)
    setDragOver(null)
  }

  function handleDragEnd() {
    setDraggingIds(null)
    setDragOver(null)
  }

  function update(id: string, patch: Partial<Cue>) {
    const next = cues.map((c) => (c.id === id ? { ...c, ...patch } : c))
    void persist(next)
  }

  function add() {
    // Default timecode: the live playhead if there is one, otherwise where
    // we left off (latest existing cue's TC, nudged one second), otherwise 0.
    let seed = currentTc
    if (!seed) {
      const latest = [...cues]
        .map((c) => parseTimecode(c.timecode))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => timecodeToMs(b, fps) - timecodeToMs(a, fps))[0]
      if (latest) {
        seed = `${String(latest.hours).padStart(2, '0')}:${String(latest.minutes).padStart(2, '0')}:${String(latest.seconds + 1).padStart(2, '0')}:00`
      }
    }
    const lastCh = cues[cues.length - 1]?.channel ?? 1
    const created = newCue(seed || '00:00:00:00', lastCh)
    void persist([...cues, created])
    setSelected(new Set([created.id]))
    setLastAnchorId(created.id)
  }

  function capture(id: string) {
    if (!currentTc) return
    update(id, { timecode: currentTc })
  }

  function remove(id: string) {
    void persist(cues.filter((c) => c.id !== id))
    if (selected.has(id)) {
      const next = new Set(selected)
      next.delete(id)
      setSelected(next)
    }
    if (lastAnchorId === id) setLastAnchorId(null)
  }

  function testFire(c: Cue) {
    fireCue(c)
    markFired(c.id)
  }

  function rearm() {
    // Forget every fire we've recorded in this pass and re-anchor to the
    // current playhead. After this, cues behind the playhead are `past`
    // (not an alert) and cues ahead will fire normally on crossing.
    prevTcMsRef.current = null
    clearFiredHistory()
    setTcAnchor(currentMs)
  }

  const hasLiveTc = currentMs !== null

  const headerInfo = useMemo(() => {
    const parts = [
      `${cues.length} cue${cues.length === 1 ? '' : 's'}`,
      `${fps} fps`,
    ]
    if (view.collisionCount > 0) {
      parts.push(
        `${view.collisionCount} conflict${view.collisionCount === 1 ? '' : 's'}`,
      )
    }
    if (view.invalidCount > 0) {
      parts.push(`${view.invalidCount} invalid`)
    }
    return parts.join(' · ')
  }, [cues.length, fps, view.collisionCount, view.invalidCount])

  return (
    <div
      ref={panelRef}
      className="panel"
      onClick={(e) => {
        // Click on the panel chrome (not on a row) clears selection, so
        // there's an obvious "deselect everything" affordance. Interactive
        // children stopPropagation below where needed.
        if (e.target === e.currentTarget && selected.size > 0) {
          setSelected(new Set())
        }
      }}
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
            color: dirty
              ? 'var(--warn)'
              : view.collisionCount > 0
                ? 'var(--bad)'
                : 'var(--muted)',
            fontSize: 11,
          }}
        >
          {dirty ? 'saving…' : headerInfo}
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
            onClick={rearm}
            title="Re-arm: reset fire history for this pass and anchor here"
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
              <th
                className="drag-handle-head"
                title="Drag to reorder. Shift/⌘-click to multi-select."
              ></th>
              <th style={{ width: 68 }}>State</th>
              <th style={{ width: 36 }}>On</th>
              <th style={{ width: 140 }}>Timecode</th>
              <th>Name</th>
              <th style={{ width: 72 }} title="MIDI output channel (1-16)">
                Ch
              </th>
              <th style={{ width: 80 }} title="Program Change number (0-127)">
                PC #
              </th>
              <th style={{ width: 140 }}></th>
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
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
            {view.rows.map((row) => {
              const { cue: c, state, hasConflict } = row
              const tcValid = state !== 'invalid'
              const isSelected = selected.has(c.id)
              const isDragging = draggingIds?.includes(c.id) ?? false
              const showDropIndicator =
                !!dragOver &&
                dragOver.id === c.id &&
                !draggingIds?.includes(c.id)
              const rowClasses = [
                `state-${state}`,
                hasConflict ? 'has-conflict' : '',
                isSelected ? 'selected' : '',
                isDragging ? 'dragging' : '',
                showDropIndicator && dragOver?.pos === 'before'
                  ? 'drop-above'
                  : '',
                showDropIndicator && dragOver?.pos === 'after'
                  ? 'drop-below'
                  : '',
                lastFiredCueId === c.id ? 'latest-fired' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <tr
                  key={c.id}
                  className={rowClasses}
                  onDragOver={(e) => handleDragOver(c.id, e)}
                  onDrop={(e) => handleDrop(c.id, e)}
                  onDragEnd={handleDragEnd}
                >
                  <td
                    className="drag-handle"
                    draggable
                    onDragStart={(e) => handleDragStart(c.id, e)}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRowClick(c.id, e)
                    }}
                    title="Drag to reorder. Click/Shift+Click/⌘+Click to select. ⌘↑/⌘↓ to nudge."
                    aria-label="Drag to reorder"
                  >
                    ⋮⋮
                  </td>
                  <td
                    onClick={(e) => {
                      // Clicks in the State cell also select the row (but
                      // ignore clicks on the inner badge's title/tooltip).
                      e.stopPropagation()
                      handleRowClick(c.id, e)
                    }}
                  >
                    <span
                      className={`state-badge badge-${state}`}
                      title={STATE_TOOLTIP[state]}
                    >
                      {STATE_LABEL[state]}
                    </span>
                  </td>
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
