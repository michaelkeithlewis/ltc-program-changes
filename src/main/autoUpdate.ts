import { app, BrowserWindow, dialog } from 'electron'
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater'
import type { UpdateEvent } from '../shared/types'

/**
 * Sets up the auto-update flow.
 *
 * Behaviour:
 * - Checks for updates from the GitHub release channel configured in
 *   `package.json > build.publish` (provider: github).
 * - Runs on startup (after a short delay so it doesn't compete with the
 *   initial window + IO bring-up) and every 6 hours thereafter.
 * - Prompts the user before downloading, and again before restarting.
 * - Silently no-ops in development and when running an unpacked build
 *   (electron-updater requires a packaged app with `latest*.yml`).
 *
 * Manual checks (from the UI) additionally surface "up to date" and error
 * dialogs so the user always gets feedback. The scheduled background
 * checks stay quiet on those outcomes.
 */

let mainWindowRef: BrowserWindow | null = null
let initialized = false
// True only while a user-initiated check is awaiting an outcome event.
// Used to gate the "up to date" / error dialogs so background polls stay quiet.
let manualCheckInFlight = false
// Set once update-downloaded fires, so a renderer-side "Restart now" button
// can request quitAndInstall without us having to track the original info.
let updateReady = false
// Version string for the update currently being downloaded, captured from
// `update-available`. The progress events don't carry the version, so we
// keep it on the side to forward to the renderer.
let inFlightVersion: string | null = null

function emitUpdate(event: UpdateEvent) {
  const w = mainWindowRef
  if (!w || w.isDestroyed()) return
  w.webContents.send('updates:event', event)
}

function setDockProgress(percentZeroToOne: number) {
  const w = mainWindowRef
  if (!w || w.isDestroyed()) return
  // -1 hides the progress bar (per Electron docs). Clamp anything weird.
  if (percentZeroToOne < 0 || percentZeroToOne > 1) {
    w.setProgressBar(-1)
    return
  }
  w.setProgressBar(percentZeroToOne)
}

function getDialogParent(): BrowserWindow | undefined {
  const w = mainWindowRef
  return w && !w.isDestroyed() ? w : undefined
}

function showInfo(opts: Omit<Electron.MessageBoxOptions, 'type'>) {
  const parent = getDialogParent()
  return dialog.showMessageBox(parent ?? new BrowserWindow({ show: false }), {
    type: 'info',
    ...opts,
  })
}

function showError(opts: Omit<Electron.MessageBoxOptions, 'type'>) {
  const parent = getDialogParent()
  return dialog.showMessageBox(parent ?? new BrowserWindow({ show: false }), {
    type: 'error',
    ...opts,
  })
}

export function initAutoUpdate(mainWindow: BrowserWindow | null) {
  mainWindowRef = mainWindow
  if (!app.isPackaged) return
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdate]', err)
    setDockProgress(-1)
    emitUpdate({ kind: 'error', message: err?.message ?? String(err) })
    if (manualCheckInFlight) {
      manualCheckInFlight = false
      void showError({
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: err?.message ?? String(err),
      })
    }
  })

  autoUpdater.on('update-available', async (info: UpdateInfo) => {
    manualCheckInFlight = false
    inFlightVersion = info.version
    emitUpdate({ kind: 'available', version: info.version })
    const res = await showInfo({
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `LTC Program Changes ${info.version} is available.`,
      detail:
        'Download now? You can keep working — progress will appear in the status bar, and the update installs the next time you quit the app.',
    })
    if (res.response === 0) {
      // Tell the renderer we're starting; the first progress event may take a
      // moment to arrive (HTTP handshake, CDN), so this lets us show a
      // determinate-ish "Starting download…" state rather than a frozen UI.
      emitUpdate({ kind: 'downloading', version: info.version })
      void autoUpdater.downloadUpdate()
    } else {
      emitUpdate({ kind: 'dismissed' })
    }
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    if (!manualCheckInFlight) return
    manualCheckInFlight = false
    void showInfo({
      title: 'Up to date',
      message: `You're on the latest version (${info.version}).`,
    })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    setDockProgress(Math.max(0, Math.min(1, (p.percent ?? 0) / 100)))
    emitUpdate({
      kind: 'progress',
      version: inFlightVersion ?? '',
      percent: p.percent ?? 0,
      transferred: p.transferred ?? 0,
      total: p.total ?? 0,
      bytesPerSecond: p.bytesPerSecond ?? 0,
    })
  })

  autoUpdater.on('update-downloaded', async (info: UpdateInfo) => {
    updateReady = true
    setDockProgress(-1)
    emitUpdate({ kind: 'downloaded', version: info.version })
    const res = await showInfo({
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `LTC Program Changes ${info.version} has been downloaded.`,
      detail:
        'Restart the app to apply the update. You can also tap "Restart now" in the status bar at any time.',
    })
    if (res.response === 0) {
      autoUpdater.quitAndInstall()
    }
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[autoUpdate] check failed', err)
    })
  }

  setTimeout(check, 10_000)
  setInterval(check, 6 * 60 * 60 * 1000)
}

/**
 * User-initiated update check. Always surfaces some feedback:
 * - dev/unpacked builds: a "this is a dev build" notice.
 * - update available / downloaded: handled by the listeners in `initAutoUpdate`.
 * - up to date / error: dedicated dialogs (gated by `manualCheckInFlight`).
 */
export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) {
    await showInfo({
      title: 'Development build',
      message: 'Updates are only available in packaged builds.',
      detail: `You're running a development build (v${app.getVersion()}).`,
    })
    return
  }

  if (!initialized) {
    // Defensive: initAutoUpdate should have run on app ready, but if it
    // didn't (e.g. main window wasn't yet created) wire up listeners now
    // so this manual check actually produces dialogs.
    initAutoUpdate(mainWindowRef)
  }

  if (manualCheckInFlight) return
  manualCheckInFlight = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // The 'error' event handler will clear the flag and show a dialog;
    // log here for completeness in case the event doesn't fire.
    console.error('[autoUpdate] manual check failed', err)
  }
}

/**
 * Renderer-triggered "Restart now" — only acts if a download has completed.
 * Otherwise no-ops so a stale or accidental call can't bring the app down
 * with no replacement to install.
 */
export function installUpdateNow(): void {
  if (!updateReady) return
  autoUpdater.quitAndInstall()
}
