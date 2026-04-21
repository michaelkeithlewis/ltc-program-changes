export type FrameRate = 24 | 25 | 29.97 | 30

export interface Timecode {
  hours: number
  minutes: number
  seconds: number
  frames: number
  dropFrame?: boolean
}

export type CueType = 'programChange' | 'dliveScene'

export interface CueBase {
  id: string
  name: string
  timecode: string // "HH:MM:SS:FF"
  enabled: boolean
  channel: number // 1-16 (MIDI channel displayed to user)
}

export interface ProgramChangeCue extends CueBase {
  type: 'programChange'
  program: number // 0-127
  bankMsb?: number // optional CC0
  bankLsb?: number // optional CC32
}

export interface DliveSceneCue extends CueBase {
  type: 'dliveScene'
  // dLive scenes 1..500. We'll translate to Bank LSB + Program.
  scene: number
}

export type Cue = ProgramChangeCue | DliveSceneCue

export interface DliveConnectionConfig {
  host: string
  port: number
  autoReconnect: boolean
}

export type ConnectionStatus =
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'connected'; since: number; remote: string }
  | { state: 'error'; message: string }

export interface MidiLogEntry {
  id: string
  at: number // ms since epoch
  direction: 'out' | 'in'
  bytes: number[]
  label: string
  channel?: number
  kind?: string
}

export interface LastReceivedSnapshot {
  byChannel: Record<number, { at: number; label: string; kind: string }>
  lastProgramChange: Record<number, { at: number; program: number }>
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * A "show" or "session". Contains the cue list plus show-specific playback
 * settings. Connection settings (dLive IP/port) are global on purpose — they
 * belong to the venue, not the show.
 */
export interface Workspace {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  cues: Cue[]
  frameRate: FrameRate
  preRollMs: number
  rxChannels: number[]
  /**
   * RtAudio numeric device id. We key by id + name so renamed devices still
   * resolve across reboots (we fall back to name matching).
   */
  audioInputDeviceId?: number
  audioInputDeviceName?: string
  /** 1-indexed channel on the selected input device. Default 1. */
  audioInputChannel?: number
}

export interface WorkspaceSummary {
  id: string
  name: string
  cueCount: number
  updatedAt: number
}

export const WORKSPACE_FILE_VERSION = 1

/** The shape of an exported .json workspace file. */
export interface WorkspaceExport {
  $schema: 'ltc-program-changes/workspace'
  version: number
  workspace: Workspace
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * App-wide settings (global). Per-show values live on the workspace itself.
 * `frameRate`, `preRollMs`, `rxChannels`, and `audioInputDeviceId` are kept
 * here as convenience mirrors of the active workspace so consumers don't
 * have to resolve them; saving updates both.
 */
export interface AppSettings {
  dlive: DliveConnectionConfig
  frameRate: FrameRate
  audioInputDeviceId?: number
  audioInputDeviceName?: string
  audioInputChannel?: number
  preRollMs: number
  rxChannels: number[]
  currentWorkspaceId: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  dlive: {
    host: '192.168.1.70',
    port: 51325,
    autoReconnect: true,
  },
  frameRate: 30,
  preRollMs: 0,
  rxChannels: [],
  currentWorkspaceId: '',
}

// ---------------------------------------------------------------------------
// Audio / LTC
// ---------------------------------------------------------------------------

export interface AudioDeviceInfo {
  id: number
  name: string
  inputChannels: number
  preferredSampleRate: number
  sampleRates: number[]
  isDefaultInput: boolean
}

export interface AudioStatus {
  running: boolean
  deviceId: number | null
  deviceName: string | null
  channel: number | null
  channelCount: number | null
  sampleRate: number | null
}

export interface LtcFrameEvent {
  tc: string
  df: boolean
  at: number
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export interface IpcApi {
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
  dlive: {
    connect: (cfg?: Partial<DliveConnectionConfig>) => Promise<ConnectionStatus>
    disconnect: () => Promise<void>
    status: () => Promise<ConnectionStatus>
    sendBytes: (bytes: number[], label?: string) => Promise<void>
  }
  cues: {
    list: () => Promise<Cue[]>
    save: (cues: Cue[]) => Promise<void>
  }
  workspaces: {
    list: () => Promise<WorkspaceSummary[]>
    current: () => Promise<Workspace | null>
    switchTo: (id: string) => Promise<Workspace>
    create: (name: string) => Promise<Workspace>
    rename: (id: string, name: string) => Promise<void>
    duplicate: (id: string) => Promise<Workspace>
    delete: (id: string) => Promise<void>
    exportTo: (id: string) => Promise<{ path: string | null }>
    importFrom: () => Promise<{ workspace: Workspace | null }>
  }
  system: {
    showDataFolder: () => Promise<void>
    dataPath: () => Promise<string>
  }
  audio: {
    listDevices: () => Promise<AudioDeviceInfo[]>
    start: (opts: { deviceId: number; channel: number }) => Promise<AudioStatus>
    stop: () => Promise<AudioStatus>
    status: () => Promise<AudioStatus>
  }
  log: {
    recent: () => Promise<MidiLogEntry[]>
    received: () => Promise<LastReceivedSnapshot>
  }
  onStatus: (cb: (s: ConnectionStatus) => void) => () => void
  onMidi: (cb: (e: MidiLogEntry) => void) => () => void
  onReceived: (cb: (s: LastReceivedSnapshot) => void) => () => void
  onWorkspaces: (cb: (list: WorkspaceSummary[]) => void) => () => void
  onLtcFrame: (cb: (f: LtcFrameEvent) => void) => () => void
  onLtcLevel: (cb: (rms: number) => void) => () => void
  onAudioStatus: (cb: (s: AudioStatus) => void) => () => void
}

declare global {
  interface Window {
    api: IpcApi
  }
}
