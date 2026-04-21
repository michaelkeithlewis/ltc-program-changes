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
  lastFiredCueId: string | null

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
  lastFiredCueId: null,

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
    set({ currentTc: '', tcSource: 'none', tcLastAt: 0 }),
  setLastFired: (id) => set({ lastFiredCueId: id }),
}))
