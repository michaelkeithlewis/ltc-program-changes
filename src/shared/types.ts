export type FrameRate = 24 | 25 | 29.97 | 30

export interface Timecode {
  hours: number
  minutes: number
  seconds: number
  frames: number
  dropFrame?: boolean
}

/**
 * A single cue. On dLive, "scene recall" is already a bank-select + PC
 * triplet, so we only need one cue type: a plain Program Change (+ optional
 * banking for dLive scenes > 128). Keeping `type: 'programChange'` on the
 * shape so legacy files that still have it don't break.
 */
export interface Cue {
  id: string
  type: 'programChange'
  name: string
  timecode: string // "HH:MM:SS:FF"
  enabled: boolean
  channel: number // 1-16
  program: number // 0-127
  bankMsb?: number // optional CC0
  bankLsb?: number // optional CC32
}

/** Alias kept for backwards compat with helpers outside the UI path. */
export type ProgramChangeCue = Cue

export interface DliveConnectionConfig {
  host: string
  port: number
  autoReconnect: boolean
  /**
   * Optional local IPv4/IPv6 address to bind the outbound TCP socket to.
   * Used when the control machine has multiple NICs (e.g. Wi-Fi for
   * internet + a wired NIC on the dLive control VLAN) and the OS routing
   * table would otherwise pick the wrong one. Empty/undefined = let the
   * OS choose via the routing table.
   */
  localAddress?: string
}

/**
 * Lightweight description of a local network interface address, surfaced
 * to the renderer so the user can pick which NIC to use for dLive control.
 */
export interface NetworkInterfaceInfo {
  /** OS interface name, e.g. `en0`, `eth1`, `Ethernet 2`. */
  name: string
  /** IPv4 or IPv6 address currently bound on this interface. */
  address: string
  family: 'IPv4' | 'IPv6'
  /** Subnet mask / prefix in CIDR-style notation, e.g. `255.255.255.0`. */
  netmask: string
  mac: string
  internal: boolean
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
  /** How many times the decoder has been kicked back into sync by the watchdog. */
  resyncs?: number
  /** How many times the underlying RtAudio stream has been rebuilt. */
  streamRestarts?: number
  /** How many decoded frames have been dropped by the corroboration filter. */
  rejectedFrames?: number
}

/** Non-fatal notice from the audio service — useful for surfacing resyncs / recoveries in the UI. */
export interface AudioWarning {
  kind:
    | 'decoder-resynced'
    | 'stream-stalled'
    | 'stream-restart-failed'
    | (string & {})
  message: string
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
    listNetworkInterfaces: () => Promise<NetworkInterfaceInfo[]>
    appVersion: () => Promise<string>
    checkForUpdates: () => Promise<void>
    /**
     * Restart the app and apply a pending update. Safe to call only when an
     * `update-downloaded` event has been observed; otherwise no-ops.
     */
    installUpdate: () => Promise<void>
  }
  audio: {
    listDevices: () => Promise<AudioDeviceInfo[]>
    start: (opts: { deviceId: number; channel: number }) => Promise<AudioStatus>
    stop: () => Promise<AudioStatus>
    status: () => Promise<AudioStatus>
    resync: () => Promise<AudioStatus>
  }
  log: {
    recent: () => Promise<MidiLogEntry[]>
    received: () => Promise<LastReceivedSnapshot>
  }
  onStatus: (cb: (s: ConnectionStatus) => void) => () => void
  onMidi: (cb: (e: MidiLogEntry) => void) => () => void
  onMidiBatch: (cb: (batch: MidiLogEntry[]) => void) => () => void
  onReceived: (cb: (s: LastReceivedSnapshot) => void) => () => void
  onWorkspaces: (cb: (list: WorkspaceSummary[]) => void) => () => void
  onLtcFrame: (cb: (f: LtcFrameEvent) => void) => () => void
  onLtcLevel: (cb: (rms: number) => void) => () => void
  onAudioStatus: (cb: (s: AudioStatus) => void) => () => void
  onAudioWarning: (cb: (w: AudioWarning) => void) => () => void
  onUpdateEvent: (cb: (e: UpdateEvent) => void) => () => void
}

/**
 * Lifecycle events broadcast from the auto-updater in the main process to
 * the renderer so the UI can show progress feedback. The shape mirrors the
 * states electron-updater itself reports, plus a synthetic `dismissed`
 * emitted when the user declines the "Download" prompt.
 */
export type UpdateEvent =
  | { kind: 'available'; version: string }
  | { kind: 'dismissed' }
  | { kind: 'downloading'; version: string }
  | {
      kind: 'progress'
      version: string
      percent: number          /* 0..100 */
      transferred: number      /* bytes */
      total: number            /* bytes */
      bytesPerSecond: number
    }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

declare global {
  interface Window {
    api: IpcApi
  }
}
