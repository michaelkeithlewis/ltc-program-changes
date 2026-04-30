import { create } from 'zustand'
import type {
  AppSettings,
  ConnectionStatus,
  Cue,
  LastReceivedSnapshot,
  MidiLogEntry,
  WorkspaceSummary,
} from '../../shared/types'

interface AppState {
  settings: AppSettings | null
  cues: Cue[]
  status: ConnectionStatus
  log: MidiLogEntry[]
  received: LastReceivedSnapshot
  workspaces: WorkspaceSummary[]
  currentTc: string
  tcSource: 'none' | 'ltc' | 'simulator'
  tcLastAt: number
  /**
   * Playhead position (ms) when the current playback pass started — i.e. the
   * first TC frame after a period of no-TC, or the moment the user last hit
   * Re-arm. Cues with trigger times before this are treated as `past` rather
   * than `missed`, which is how the UI avoids screaming at the operator
   * when they join a show mid-way.
   */
  tcAnchorMs: number | null
  lastFiredCueId: string | null
  /** id → epoch-ms of when this cue was fired in the current pass. */
  firedCueIds: Record<string, number>
  /**
   * Whether the right-hand MIDI Monitor pane is shown. Persisted to
   * localStorage so the user's choice survives reloads. Default: visible.
   */
  monitorVisible: boolean

  setSettings: (s: AppSettings) => void
  setCues: (c: Cue[]) => void
  setStatus: (s: ConnectionStatus) => void
  appendLog: (e: MidiLogEntry) => void
  appendLogBatch: (entries: MidiLogEntry[]) => void
  setLog: (e: MidiLogEntry[]) => void
  setReceived: (s: LastReceivedSnapshot) => void
  setWorkspaces: (w: WorkspaceSummary[]) => void
  setTimecode: (tc: string, source: 'ltc' | 'simulator') => void
  clearTimecode: () => void
  setLastFired: (id: string | null) => void
  /** Record a fire event for the given cue and mark it as the last-fired. */
  markFired: (id: string, at?: number) => void
  /** Reset all per-pass fire history. Called by the Re-arm button. */
  clearFiredHistory: () => void
  /** Manually set the pass anchor (normally managed automatically). */
  setTcAnchor: (ms: number | null) => void
  setMonitorVisible: (v: boolean) => void
}

const MONITOR_VISIBLE_KEY = 'ui.monitorVisible'
function readMonitorVisible(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(MONITOR_VISIBLE_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}
function writeMonitorVisible(v: boolean) {
  try {
    window.localStorage.setItem(MONITOR_VISIBLE_KEY, v ? '1' : '0')
  } catch {
    // localStorage may be disabled / quota exceeded — non-fatal.
  }
}

export const useApp = create<AppState>((set) => ({
  settings: null,
  cues: [],
  status: { state: 'disconnected' },
  log: [],
  received: { byChannel: {}, lastProgramChange: {} },
  workspaces: [],
  currentTc: '',
  tcSource: 'none',
  tcLastAt: 0,
  tcAnchorMs: null,
  lastFiredCueId: null,
  firedCueIds: {},
  monitorVisible: readMonitorVisible(),

  setSettings: (s) => set({ settings: s }),
  setCues: (c) => set({ cues: c }),
  setStatus: (s) => set({ status: s }),
  appendLog: (e) => set((st) => ({ log: [...st.log.slice(-399), e] })),
  appendLogBatch: (entries) =>
    set((st) => {
      if (entries.length === 0) return {}
      const merged = [...st.log, ...entries]
      const trimmed =
        merged.length > 400 ? merged.slice(merged.length - 400) : merged
      return { log: trimmed }
    }),
  setLog: (e) => set({ log: e }),
  setReceived: (s) => set({ received: s }),
  setWorkspaces: (w) => set({ workspaces: w }),
  setTimecode: (tc, source) =>
    set({ currentTc: tc, tcSource: source, tcLastAt: Date.now() }),
  clearTimecode: () =>
    set({
      currentTc: '',
      tcSource: 'none',
      tcLastAt: 0,
      // Drop the anchor so the next run of TC establishes a fresh one.
      tcAnchorMs: null,
    }),
  setLastFired: (id) => set({ lastFiredCueId: id }),
  markFired: (id, at = Date.now()) =>
    set((st) => ({
      lastFiredCueId: id,
      firedCueIds: { ...st.firedCueIds, [id]: at },
    })),
  clearFiredHistory: () =>
    set({ lastFiredCueId: null, firedCueIds: {} }),
  setTcAnchor: (ms) => set({ tcAnchorMs: ms }),
  setMonitorVisible: (v) => {
    writeMonitorVisible(v)
    set({ monitorVisible: v })
  },
}))
