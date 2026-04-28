import type { Cue } from '../../shared/types'
import { parseTimecode, timecodeToMs } from '../../shared/midi'

/**
 * The live, derived state of a single cue relative to the playhead.
 *
 *  - `disabled` — user has turned the cue off.
 *  - `invalid`  — timecode string doesn't parse.
 *  - `idle`     — no live TC yet; we have nothing to compare against, so the
 *                 cue is drawn neutrally.
 *  - `past`     — cue is behind the current playback pass's starting point
 *                 (see `tcAnchorMs` below). Not an error; the operator
 *                 simply joined the show mid-way.
 *  - `missed`   — cue's trigger was crossed DURING this pass but no fire
 *                 was recorded. This is the "something went wrong" state.
 *  - `fired`    — cue was fired (either by the scheduler or a manual Fire
 *                 click) during the current pass.
 *  - `next`     — the single earliest upcoming enabled/valid cue.
 *  - `armed`    — any other upcoming enabled/valid cue.
 */
export type CueRuntimeState =
  | 'disabled'
  | 'invalid'
  | 'idle'
  | 'past'
  | 'missed'
  | 'fired'
  | 'next'
  | 'armed'

export interface CueRow {
  cue: Cue
  /** Resolved trigger time in ms (cue TC converted under the given fps), or
   *  `null` if the cue's TC failed to parse. */
  ms: number | null
  state: CueRuntimeState
  /** When the cue was fired during this pass, or `null`. */
  firedAt: number | null
  /**
   * True if this cue's trigger window overlaps another enabled+valid cue
   * within pre-roll (or lands on the same TC when pre-roll = 0). Display
   * order is user-controlled now, so we can't rely on the previous row
   * being the time-adjacent one — this flag is set on *every* member of
   * a conflicting pair so the operator spots it wherever the row sits.
   */
  hasConflict: boolean
}

export interface CueListView {
  rows: CueRow[]
  enabledCount: number
  invalidCount: number
  collisionCount: number
  /** Index into `rows` of the `next` cue, or -1 if there is no upcoming cue. */
  nextIndex: number
}

export interface BuildCueRowsInput {
  cues: Cue[]
  fps: number
  /** MIDI pre-roll in ms. Cues fire `preRollMs` before their TC. */
  preRollMs: number
  /** Current playhead in ms, or `null` if no TC is flowing. */
  currentMs: number | null
  /** Playhead position when the current playback pass started (first frame
   *  after a period of no-TC, or the last Re-arm). Cues with triggers before
   *  this are considered `past` rather than `missed`. `null` means we have no
   *  anchor yet (treat everything behind the playhead as `past`). */
  tcAnchorMs: number | null
  /** id → ms-since-epoch of when this cue was last fired in the current pass. */
  firedIds: Record<string, number>
}

/**
 * Turn the raw cue list + runtime context into a sorted, state-tagged view.
 *
 * Pure and synchronous — no React, no IPC. Intended to be memoised by the
 * caller when inputs change.
 */
export function buildCueRows(input: BuildCueRowsInput): CueListView {
  const { cues, fps, preRollMs, currentMs, tcAnchorMs, firedIds } = input

  // 1) Decorate with resolved ms. We keep the caller's array order for
  //    display, but compute next-cue and time-conflicts against all cues
  //    regardless of where they sit in the user's manual arrangement.
  type Decorated = { cue: Cue; ms: number | null }
  const decorated: Decorated[] = cues.map((c) => {
    const tc = parseTimecode(c.timecode)
    return { cue: c, ms: tc ? timecodeToMs(tc, fps) : null }
  })

  // 2) Find the "next" cue — earliest enabled+valid cue whose trigger is
  //    strictly in the future relative to the current playhead. Must scan
  //    everything now that we don't pre-sort.
  let nextIndex = -1
  if (currentMs !== null) {
    let bestTrigger = Number.POSITIVE_INFINITY
    for (let i = 0; i < decorated.length; i++) {
      const { cue, ms } = decorated[i]
      if (!cue.enabled || ms === null) continue
      const trigger = ms - preRollMs
      if (trigger > currentMs && trigger < bestTrigger) {
        bestTrigger = trigger
        nextIndex = i
      }
    }
  }

  // 3) Time-conflict detection. For each enabled+valid cue, check whether
  //    any OTHER enabled+valid cue sits within pre-roll of it (or shares
  //    a TC when pre-roll = 0). We flag both members of every conflicting
  //    pair so the operator sees the warning regardless of display order.
  //    O(n²) but n is tiny (tens, not thousands).
  const conflict = new Array<boolean>(decorated.length).fill(false)
  for (let i = 0; i < decorated.length; i++) {
    const a = decorated[i]
    if (!a.cue.enabled || a.ms === null) continue
    for (let j = i + 1; j < decorated.length; j++) {
      const b = decorated[j]
      if (!b.cue.enabled || b.ms === null) continue
      const gap = Math.abs(a.ms - b.ms)
      const overlap = preRollMs > 0 ? gap < preRollMs : gap === 0
      if (overlap) {
        conflict[i] = true
        conflict[j] = true
      }
    }
  }

  // 4) Per-row state in display order.
  const rows: CueRow[] = []
  let collisionCount = 0
  let enabledCount = 0
  let invalidCount = 0

  for (let i = 0; i < decorated.length; i++) {
    const { cue, ms } = decorated[i]
    const firedAt = firedIds[cue.id] ?? null
    if (cue.enabled) enabledCount += 1
    if (ms === null) invalidCount += 1
    if (conflict[i]) collisionCount += 1

    let state: CueRuntimeState
    if (!cue.enabled) {
      state = 'disabled'
    } else if (ms === null) {
      state = 'invalid'
    } else if (firedAt !== null) {
      state = 'fired'
    } else if (currentMs === null) {
      state = 'idle'
    } else {
      const trigger = ms - preRollMs
      if (trigger <= currentMs) {
        // Behind the playhead and not fired. If the anchor exists and this
        // cue's trigger is before it, the operator joined mid-show — call
        // that `past`, not an alert. Otherwise it's a real miss.
        if (tcAnchorMs !== null && trigger < tcAnchorMs) {
          state = 'past'
        } else {
          state = 'missed'
        }
      } else if (i === nextIndex) {
        state = 'next'
      } else {
        state = 'armed'
      }
    }

    rows.push({ cue, ms, state, firedAt, hasConflict: conflict[i] })
  }

  return { rows, enabledCount, invalidCount, collisionCount, nextIndex }
}

/**
 * Sort cues by timecode without computing state. Useful when callers (e.g.
 * the fire scheduler) only need the ordered list.
 */
export function sortCuesByTimecode(cues: Cue[], fps: number): Cue[] {
  return cues
    .map((c) => {
      const tc = parseTimecode(c.timecode)
      return { cue: c, ms: tc ? timecodeToMs(tc, fps) : Number.POSITIVE_INFINITY }
    })
    .sort((a, b) => a.ms - b.ms)
    .map((d) => d.cue)
}
