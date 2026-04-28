import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AudioDeviceInfo,
  AudioStatus,
  ConnectionStatus,
  Cue,
  DliveConnectionConfig,
  IpcApi,
  LastReceivedSnapshot,
  LtcFrameEvent,
  MidiLogEntry,
  NetworkInterfaceInfo,
  Workspace,
  WorkspaceSummary,
} from '../shared/types'

const api: IpcApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    set: (patch) =>
      ipcRenderer.invoke('settings:set', patch) as Promise<AppSettings>,
  },
  dlive: {
    connect: (cfg?: Partial<DliveConnectionConfig>) =>
      ipcRenderer.invoke('dlive:connect', cfg) as Promise<ConnectionStatus>,
    disconnect: () => ipcRenderer.invoke('dlive:disconnect') as Promise<void>,
    status: () => ipcRenderer.invoke('dlive:status') as Promise<ConnectionStatus>,
    sendBytes: (bytes, label) =>
      ipcRenderer.invoke('dlive:send', bytes, label) as Promise<void>,
  },
  cues: {
    list: () => ipcRenderer.invoke('cues:list') as Promise<Cue[]>,
    save: (cues) => ipcRenderer.invoke('cues:save', cues) as Promise<void>,
  },
  workspaces: {
    list: () =>
      ipcRenderer.invoke('workspaces:list') as Promise<WorkspaceSummary[]>,
    current: () =>
      ipcRenderer.invoke('workspaces:current') as Promise<Workspace | null>,
    switchTo: (id) =>
      ipcRenderer.invoke('workspaces:switch', id) as Promise<Workspace>,
    create: (name) =>
      ipcRenderer.invoke('workspaces:create', name) as Promise<Workspace>,
    rename: (id, name) =>
      ipcRenderer.invoke('workspaces:rename', id, name) as Promise<void>,
    duplicate: (id) =>
      ipcRenderer.invoke('workspaces:duplicate', id) as Promise<Workspace>,
    delete: (id) => ipcRenderer.invoke('workspaces:delete', id) as Promise<void>,
    exportTo: (id) =>
      ipcRenderer.invoke('workspaces:export', id) as Promise<{
        path: string | null
      }>,
    importFrom: () =>
      ipcRenderer.invoke('workspaces:import') as Promise<{
        workspace: Workspace | null
      }>,
  },
  system: {
    showDataFolder: () =>
      ipcRenderer.invoke('system:showDataFolder') as Promise<void>,
    dataPath: () => ipcRenderer.invoke('system:dataPath') as Promise<string>,
    listNetworkInterfaces: () =>
      ipcRenderer.invoke('system:listNetworkInterfaces') as Promise<
        NetworkInterfaceInfo[]
      >,
  },
  audio: {
    listDevices: () =>
      ipcRenderer.invoke('audio:listDevices') as Promise<AudioDeviceInfo[]>,
    start: (opts) =>
      ipcRenderer.invoke('audio:start', opts) as Promise<AudioStatus>,
    stop: () => ipcRenderer.invoke('audio:stop') as Promise<AudioStatus>,
    status: () => ipcRenderer.invoke('audio:status') as Promise<AudioStatus>,
    resync: () => ipcRenderer.invoke('audio:resync') as Promise<AudioStatus>,
  },
  log: {
    recent: () => ipcRenderer.invoke('log:recent') as Promise<MidiLogEntry[]>,
    received: () =>
      ipcRenderer.invoke('log:received') as Promise<LastReceivedSnapshot>,
  },
  onStatus: (cb) => {
    const listener = (_e: unknown, s: ConnectionStatus) => cb(s)
    ipcRenderer.on('dlive:status', listener)
    return () => ipcRenderer.off('dlive:status', listener)
  },
  onMidi: (cb) => {
    const listener = (_e: unknown, m: MidiLogEntry) => cb(m)
    ipcRenderer.on('midi:log', listener)
    return () => ipcRenderer.off('midi:log', listener)
  },
  onMidiBatch: (cb) => {
    const listener = (_e: unknown, batch: MidiLogEntry[]) => cb(batch)
    ipcRenderer.on('midi:logBatch', listener)
    return () => ipcRenderer.off('midi:logBatch', listener)
  },
  onReceived: (cb) => {
    const listener = (_e: unknown, s: LastReceivedSnapshot) => cb(s)
    ipcRenderer.on('midi:received', listener)
    return () => ipcRenderer.off('midi:received', listener)
  },
  onWorkspaces: (cb) => {
    const listener = (_e: unknown, s: WorkspaceSummary[]) => cb(s)
    ipcRenderer.on('workspaces:list', listener)
    return () => ipcRenderer.off('workspaces:list', listener)
  },
  onLtcFrame: (cb) => {
    const listener = (_e: unknown, f: LtcFrameEvent) => cb(f)
    ipcRenderer.on('ltc:frame', listener)
    return () => ipcRenderer.off('ltc:frame', listener)
  },
  onLtcLevel: (cb) => {
    const listener = (_e: unknown, rms: number) => cb(rms)
    ipcRenderer.on('ltc:level', listener)
    return () => ipcRenderer.off('ltc:level', listener)
  },
  onAudioStatus: (cb) => {
    const listener = (_e: unknown, s: AudioStatus) => cb(s)
    ipcRenderer.on('audio:status', listener)
    return () => ipcRenderer.off('audio:status', listener)
  },
  onAudioWarning: (cb) => {
    const listener = (
      _e: unknown,
      w: { kind: string; message: string },
    ) => cb(w)
    ipcRenderer.on('audio:warning', listener)
    return () => ipcRenderer.off('audio:warning', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)
