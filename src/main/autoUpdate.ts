import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'

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
    const res = await showInfo({
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `LTC Program Changes ${info.version} is available.`,
      detail: 'Download now? The update will install the next time you quit the app.',
    })
    if (res.response === 0) {
      void autoUpdater.downloadUpdate()
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

  autoUpdater.on('update-downloaded', async (info: UpdateInfo) => {
    const res = await showInfo({
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `LTC Program Changes ${info.version} has been downloaded.`,
      detail: 'Restart the app to apply the update.',
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
