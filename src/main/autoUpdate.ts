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
 */
export function initAutoUpdate(mainWindow: BrowserWindow | null) {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdate]', err)
  })

  autoUpdater.on('update-available', async (info: UpdateInfo) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const res = await dialog.showMessageBox(win ?? new BrowserWindow({ show: false }), {
      type: 'info',
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

  autoUpdater.on('update-downloaded', async (info: UpdateInfo) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const res = await dialog.showMessageBox(win ?? new BrowserWindow({ show: false }), {
      type: 'info',
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
