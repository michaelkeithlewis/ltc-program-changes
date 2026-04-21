import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  WORKSPACE_FILE_VERSION,
  type AppSettings,
  type Cue,
  type Workspace,
  type WorkspaceSummary,
} from '../shared/types'

interface FileShape {
  version: number
  settings: AppSettings
  workspaces: Workspace[]
}

type LegacyShape = {
  settings?: Omit<Partial<AppSettings>, 'audioInputDeviceId'> & {
    frameRate?: number
    preRollMs?: number
    rxChannels?: number[]
    /** v0 used WebRTC device ids (hex strings). Dropped on migration. */
    audioInputDeviceId?: string | number
  }
  cues?: Cue[]
}

const LATEST_VERSION = 1

function uid(prefix = 'ws'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function makeWorkspace(name: string): Workspace {
  const now = Date.now()
  return {
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    cues: [],
    frameRate: 30,
    preRollMs: 0,
    rxChannels: [],
  }
}

function defaultFile(): FileShape {
  const ws = makeWorkspace('Default show')
  return {
    version: LATEST_VERSION,
    settings: { ...DEFAULT_SETTINGS, currentWorkspaceId: ws.id },
    workspaces: [ws],
  }
}

class JsonStore {
  private file: string
  private data: FileShape

  constructor(filename: string) {
    this.file = path.join(app.getPath('userData'), filename)
    this.data = this.load()
  }

  getFilePath(): string {
    return this.file
  }

  getDataDir(): string {
    return path.dirname(this.file)
  }

  private load(): FileShape {
    try {
      if (!fs.existsSync(this.file)) return defaultFile()
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<FileShape> | LegacyShape

      if (isLegacy(parsed)) return migrateLegacy(parsed)

      // Already v1.
      const fileLike = parsed as Partial<FileShape>
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(fileLike.settings ?? {}),
      }
      let workspaces = fileLike.workspaces ?? []
      if (workspaces.length === 0) {
        workspaces = [makeWorkspace('Default show')]
      }
      // One-shot clean-up: we used to store a string (WebRTC hex id) for
      // audioInputDeviceId. Any such value is useless under RtAudio.
      for (const w of workspaces) {
        if (typeof w.audioInputDeviceId !== 'number') {
          w.audioInputDeviceId = undefined
          w.audioInputDeviceName = undefined
        }
      }
      if (typeof settings.audioInputDeviceId !== 'number') {
        settings.audioInputDeviceId = undefined
        settings.audioInputDeviceName = undefined
      }
      if (
        !settings.currentWorkspaceId ||
        !workspaces.find((w) => w.id === settings.currentWorkspaceId)
      ) {
        settings.currentWorkspaceId = workspaces[0].id
      }
      this.syncMirroredSettings(settings, workspaces)
      return { version: LATEST_VERSION, settings, workspaces }
    } catch (err) {
      console.error('store load failed, using defaults', err)
      return defaultFile()
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('store persist failed', err)
    }
  }

  /** Keep the convenience mirrors on `settings` in sync with the active ws. */
  private syncMirroredSettings(settings: AppSettings, workspaces: Workspace[]) {
    const ws = workspaces.find((w) => w.id === settings.currentWorkspaceId)
    if (!ws) return
    settings.frameRate = ws.frameRate
    settings.preRollMs = ws.preRollMs
    settings.rxChannels = ws.rxChannels
    settings.audioInputDeviceId = ws.audioInputDeviceId
    settings.audioInputDeviceName = ws.audioInputDeviceName
    settings.audioInputChannel = ws.audioInputChannel
  }

  private currentWorkspace(): Workspace {
    const id = this.data.settings.currentWorkspaceId
    const ws = this.data.workspaces.find((w) => w.id === id)
    if (!ws) {
      const fallback = this.data.workspaces[0] ?? makeWorkspace('Default show')
      this.data.workspaces[0] = fallback
      this.data.settings.currentWorkspaceId = fallback.id
      return fallback
    }
    return ws
  }

  getSettings(): AppSettings {
    return this.data.settings
  }

  /**
   * Setting a mirrored field (frameRate/preRollMs/rxChannels/audioInputDeviceId)
   * also writes it onto the active workspace, so switching workspaces
   * preserves per-show values.
   */
  setSettings(patch: Partial<AppSettings>): AppSettings {
    const prev = this.data.settings
    const next: AppSettings = { ...prev, ...patch }

    // Validate / normalise.
    if (
      patch.currentWorkspaceId &&
      !this.data.workspaces.find((w) => w.id === patch.currentWorkspaceId)
    ) {
      next.currentWorkspaceId = prev.currentWorkspaceId
    }

    // Push mirrored fields into the active workspace when they change.
    const ws = this.data.workspaces.find(
      (w) => w.id === next.currentWorkspaceId,
    )
    if (ws) {
      let touched = false
      if ('frameRate' in patch && patch.frameRate !== undefined) {
        ws.frameRate = patch.frameRate
        touched = true
      }
      if ('preRollMs' in patch && patch.preRollMs !== undefined) {
        ws.preRollMs = patch.preRollMs
        touched = true
      }
      if ('rxChannels' in patch && patch.rxChannels !== undefined) {
        ws.rxChannels = patch.rxChannels
        touched = true
      }
      if ('audioInputDeviceId' in patch) {
        ws.audioInputDeviceId = patch.audioInputDeviceId
        touched = true
      }
      if ('audioInputDeviceName' in patch) {
        ws.audioInputDeviceName = patch.audioInputDeviceName
        touched = true
      }
      if ('audioInputChannel' in patch) {
        ws.audioInputChannel = patch.audioInputChannel
        touched = true
      }
      if (touched) ws.updatedAt = Date.now()
    }

    this.data.settings = next
    // If we just switched workspaces, the mirrored fields should follow the
    // newly-active workspace so the renderer sees correct values.
    if (
      patch.currentWorkspaceId &&
      patch.currentWorkspaceId !== prev.currentWorkspaceId
    ) {
      this.syncMirroredSettings(this.data.settings, this.data.workspaces)
    }
    this.persist()
    return this.data.settings
  }

  // --- Cues -----------------------------------------------------------------

  getCues(): Cue[] {
    return this.currentWorkspace().cues
  }

  setCues(cues: Cue[]) {
    const ws = this.currentWorkspace()
    ws.cues = cues
    ws.updatedAt = Date.now()
    this.persist()
  }

  // --- Workspaces -----------------------------------------------------------

  listWorkspaces(): WorkspaceSummary[] {
    return this.data.workspaces
      .map((w) => ({
        id: w.id,
        name: w.name,
        cueCount: w.cues.length,
        updatedAt: w.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getCurrentWorkspace(): Workspace {
    return this.currentWorkspace()
  }

  switchWorkspace(id: string): Workspace {
    const ws = this.data.workspaces.find((w) => w.id === id)
    if (!ws) throw new Error(`Unknown workspace: ${id}`)
    this.setSettings({ currentWorkspaceId: id })
    return ws
  }

  createWorkspace(name: string): Workspace {
    const ws = makeWorkspace(name.trim() || 'Untitled show')
    this.data.workspaces.push(ws)
    this.setSettings({ currentWorkspaceId: ws.id })
    // setSettings already persisted.
    return ws
  }

  renameWorkspace(id: string, name: string) {
    const ws = this.data.workspaces.find((w) => w.id === id)
    if (!ws) throw new Error(`Unknown workspace: ${id}`)
    ws.name = name.trim() || 'Untitled show'
    ws.updatedAt = Date.now()
    this.persist()
  }

  duplicateWorkspace(id: string): Workspace {
    const src = this.data.workspaces.find((w) => w.id === id)
    if (!src) throw new Error(`Unknown workspace: ${id}`)
    const copy: Workspace = {
      ...src,
      id: uid(),
      name: `${src.name} (copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cues: src.cues.map((c) => ({
        ...c,
        id: `c_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 6)}`,
      })),
    }
    this.data.workspaces.push(copy)
    this.setSettings({ currentWorkspaceId: copy.id })
    return copy
  }

  deleteWorkspace(id: string) {
    if (this.data.workspaces.length <= 1) {
      throw new Error('Cannot delete the last remaining workspace')
    }
    const idx = this.data.workspaces.findIndex((w) => w.id === id)
    if (idx === -1) throw new Error(`Unknown workspace: ${id}`)
    this.data.workspaces.splice(idx, 1)
    if (this.data.settings.currentWorkspaceId === id) {
      this.setSettings({
        currentWorkspaceId: this.data.workspaces[0].id,
      })
    } else {
      this.persist()
    }
  }

  importWorkspace(ws: Workspace): Workspace {
    // Always assign a fresh id to avoid collisions.
    const clone: Workspace = {
      ...ws,
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cues: (ws.cues ?? []).map((c) => ({
        ...c,
        id: `c_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 6)}`,
      })),
    }
    this.data.workspaces.push(clone)
    this.setSettings({ currentWorkspaceId: clone.id })
    return clone
  }

  getWorkspaceById(id: string): Workspace | undefined {
    return this.data.workspaces.find((w) => w.id === id)
  }
}

function isLegacy(obj: unknown): obj is LegacyShape {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  if ('version' in o && typeof o.version === 'number') return false
  return 'cues' in o || 'settings' in o
}

function migrateLegacy(legacy: LegacyShape): FileShape {
  const ws = makeWorkspace('Migrated show')
  ws.cues = legacy.cues ?? []
  if (legacy.settings?.frameRate)
    ws.frameRate = legacy.settings.frameRate as FileShape['workspaces'][number]['frameRate']
  if (typeof legacy.settings?.preRollMs === 'number')
    ws.preRollMs = legacy.settings.preRollMs
  if (Array.isArray(legacy.settings?.rxChannels))
    ws.rxChannels = legacy.settings.rxChannels
  // Legacy WebRTC device ids (hex strings) are not compatible with the new
  // RtAudio integer ids, so we drop them. User re-selects on first run.

  const legacySettings = legacy.settings ?? {}
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    dlive: { ...DEFAULT_SETTINGS.dlive, ...(legacySettings.dlive ?? {}) },
    currentWorkspaceId: ws.id,
    frameRate: ws.frameRate,
    preRollMs: ws.preRollMs,
    rxChannels: ws.rxChannels,
  }
  return { version: LATEST_VERSION, settings, workspaces: [ws] }
}

let instance: JsonStore | null = null
export function getStore(): JsonStore {
  if (!instance) instance = new JsonStore('ltc-program-changes.json')
  return instance
}

export { WORKSPACE_FILE_VERSION }
