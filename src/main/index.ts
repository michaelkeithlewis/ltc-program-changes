import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DliveClient } from './dlive'
import { getStore } from './store'
import { AudioService } from './ltc/audioService'
import { bytesToLabel } from '../shared/midi'
import { MidiStreamParser, messageLabel } from '../shared/midiParser'
import type {
  LastReceivedSnapshot,
  MidiLogEntry,
  Workspace,
  WorkspaceExport,
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let isQuitting = false
const dlive = new DliveClient()
const audio = new AudioService()
const logBuffer: MidiLogEntry[] = []
const LOG_CAP = 500
const parser = new MidiStreamParser()
const lastReceived: LastReceivedSnapshot = {
  byChannel: {},
  lastProgramChange: {},
}

/** Safely send to the renderer; no-op if window is gone. */
function sendToRenderer(channel: string, payload: unknown) {
  if (isQuitting) return
  const w = mainWindow
  if (!w || w.isDestroyed()) return
  const wc = w.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send(channel, payload)
  } catch {
    // Window was torn down between the checks and the send; ignore.
  }
}

function pushLog(entry: MidiLogEntry) {
  logBuffer.push(entry)
  if (logBuffer.length > LOG_CAP) logBuffer.splice(0, logBuffer.length - LOG_CAP)
  sendToRenderer('midi:log', entry)
}

function shouldAcceptRx(channel: number | undefined): boolean {
  const set = getStore().getSettings().rxChannels
  if (!set || set.length === 0) return true
  if (channel === undefined) return true
  return set.includes(channel)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Null the reference the moment the window closes so later emitters
  // (including the dLive disconnect during app shutdown) don't try to
  // send to a destroyed webContents.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  dlive.on('status', (s) => sendToRenderer('dlive:status', s))
  dlive.on('data', (bytes: number[]) => {
    const messages = parser.push(bytes)
    for (const m of messages) {
      if (m.kind === 'realtime' && m.bytes[0] === 0xfe) continue

      const channel = 'channel' in m ? m.channel : undefined
      if (!shouldAcceptRx(channel)) continue

      if (channel !== undefined) {
        lastReceived.byChannel[channel] = {
          at: Date.now(),
          label: messageLabel(m),
          kind: m.kind,
        }
        if (m.kind === 'programChange') {
          lastReceived.lastProgramChange[channel] = {
            at: Date.now(),
            program: m.program,
          }
        }
        sendToRenderer('midi:received', lastReceived)
      }

      pushLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        direction: 'in',
        bytes: m.bytes,
        label: messageLabel(m),
        channel,
        kind: m.kind,
      })
    }
  })

  audio.on('frame', (f) =>
    sendToRenderer('ltc:frame', { ...f, at: Date.now() }),
  )
  audio.on('level', (rms: number) => sendToRenderer('ltc:level', rms))
  audio.on('status', (s) => sendToRenderer('audio:status', s))
  audio.on('warning', (w) => sendToRenderer('audio:warning', w))

  const s = getStore().getSettings()
  if (s.dlive.autoReconnect) dlive.connect(s.dlive)

  registerIpc()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function shutdown() {
  isQuitting = true
  try {
    dlive.disconnect()
  } catch (err) {
    console.error('dlive disconnect failed', err)
  }
  try {
    audio.stop()
  } catch (err) {
    console.error('audio stop failed', err)
  }
}

app.on('before-quit', () => {
  // Tear down IO *before* the window dies so any status event that fires
  // can still be delivered — and, more importantly, is safely ignored by
  // sendToRenderer once we're in quitting mode.
  shutdown()
})

app.on('window-all-closed', () => {
  shutdown()
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc() {
  const store = getStore()

  // --- Settings -----------------------------------------------------------
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch))

  // --- Cues ---------------------------------------------------------------
  ipcMain.handle('cues:list', () => store.getCues())
  ipcMain.handle('cues:save', (_e, cues) => store.setCues(cues))

  // --- dLive --------------------------------------------------------------
  ipcMain.handle('dlive:connect', (_e, cfg) => {
    const merged = { ...store.getSettings().dlive, ...(cfg ?? {}) }
    store.setSettings({ dlive: merged })
    return dlive.connect(merged)
  })
  ipcMain.handle('dlive:disconnect', () => dlive.disconnect())
  ipcMain.handle('dlive:status', () => dlive.getStatus())
  ipcMain.handle('dlive:send', (_e, bytes: number[], label?: string) => {
    const ok = dlive.send(bytes)
    pushLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      direction: 'out',
      bytes,
      label: (ok ? '' : '[not sent] ') + (label ?? bytesToLabel(bytes)),
    })
    return ok
  })

  // --- Workspaces ---------------------------------------------------------
  const emitWorkspaces = () =>
    sendToRenderer('workspaces:list', store.listWorkspaces())

  ipcMain.handle('workspaces:list', () => store.listWorkspaces())
  ipcMain.handle('workspaces:current', () => store.getCurrentWorkspace())
  ipcMain.handle('workspaces:switch', (_e, id: string) => {
    const ws = store.switchWorkspace(id)
    emitWorkspaces()
    return ws
  })
  ipcMain.handle('workspaces:create', (_e, name: string) => {
    const ws = store.createWorkspace(name)
    emitWorkspaces()
    return ws
  })
  ipcMain.handle('workspaces:rename', (_e, id: string, name: string) => {
    store.renameWorkspace(id, name)
    emitWorkspaces()
  })
  ipcMain.handle('workspaces:duplicate', (_e, id: string) => {
    const ws = store.duplicateWorkspace(id)
    emitWorkspaces()
    return ws
  })
  ipcMain.handle('workspaces:delete', (_e, id: string) => {
    store.deleteWorkspace(id)
    emitWorkspaces()
  })
  ipcMain.handle('workspaces:export', async (_e, id: string) => {
    const ws = store.getWorkspaceById(id)
    if (!ws) return { path: null }
    if (!mainWindow) return { path: null }
    const safeName = ws.name.replace(/[^\w.-]+/g, '_') || 'workspace'
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export workspace',
      defaultPath: `${safeName}.ltcprog.json`,
      filters: [{ name: 'LTC Program Changes Workspace', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePath) return { path: null }
    const payload: WorkspaceExport = {
      $schema: 'ltc-program-changes/workspace',
      version: 1,
      workspace: ws,
    }
    await fs.promises.writeFile(
      res.filePath,
      JSON.stringify(payload, null, 2),
      'utf8',
    )
    return { path: res.filePath }
  })
  ipcMain.handle('workspaces:import', async () => {
    if (!mainWindow) return { workspace: null }
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import workspace',
      filters: [{ name: 'LTC Program Changes Workspace', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (res.canceled || res.filePaths.length === 0) return { workspace: null }
    const raw = await fs.promises.readFile(res.filePaths[0], 'utf8')
    const parsed = JSON.parse(raw) as Partial<WorkspaceExport> & {
      workspace?: Workspace
    }
    if (!parsed.workspace) throw new Error('Invalid workspace file')
    const ws = store.importWorkspace(parsed.workspace)
    emitWorkspaces()
    return { workspace: ws }
  })

  // --- System -------------------------------------------------------------
  ipcMain.handle('system:showDataFolder', async () => {
    shell.openPath(store.getDataDir())
  })
  ipcMain.handle('system:dataPath', () => store.getFilePath())

  // --- Audio / LTC --------------------------------------------------------
  ipcMain.handle('audio:listDevices', () => audio.listDevices())
  ipcMain.handle(
    'audio:start',
    (_e, opts: { deviceId: number; channel: number }) => {
      audio.start(opts)
      const st = audio.getStatus()
      store.setSettings({
        audioInputDeviceId: st.deviceId ?? undefined,
        audioInputDeviceName: st.deviceName ?? undefined,
        audioInputChannel: st.channel ?? undefined,
      })
      return st
    },
  )
  ipcMain.handle('audio:stop', () => {
    audio.stop()
    return audio.getStatus()
  })
  ipcMain.handle('audio:status', () => audio.getStatus())
  ipcMain.handle('audio:resync', () => audio.resync())

  // --- Log ----------------------------------------------------------------
  ipcMain.handle('log:recent', () => logBuffer.slice(-200))
  ipcMain.handle('log:received', () => lastReceived)
}
