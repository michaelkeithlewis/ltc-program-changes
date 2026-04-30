import { useApp } from '../store'

/**
 * Status-bar banner that surfaces auto-update progress.
 *
 *   idle         → renders nothing (returns null)
 *   downloading  → percent + speed + slim progress bar
 *   downloaded   → "Update ready" pill with a "Restart now" button
 *   error        → dismissible error chip
 *
 * The user already gets native dialogs at the start ("Download?") and end
 * ("Restart now?") of the flow; this component fills the gap in the
 * middle, where previously the only feedback was a frozen-feeling delay
 * before the second dialog appeared.
 */
export function UpdateBanner() {
  const updateUi = useApp((s) => s.updateUi)
  const clearUpdateUi = useApp((s) => s.clearUpdateUi)

  if (updateUi.kind === 'idle') return null

  if (updateUi.kind === 'downloading') {
    const pct = Math.max(0, Math.min(100, updateUi.percent))
    // Until the first real progress event lands, total is 0 and the bar
    // would look stuck. Fall back to "Starting…" copy so the user knows
    // something happened after they clicked Download.
    const starting = updateUi.total === 0
    return (
      <div
        className="update-banner is-downloading"
        role="status"
        aria-live="polite"
      >
        <span className="ub-icon" aria-hidden>⬇</span>
        <span className="ub-label">
          {starting ? (
            <>Starting download…</>
          ) : (
            <>
              Downloading <strong>v{updateUi.version}</strong> ·{' '}
              <span className="ub-num">{pct.toFixed(0)}%</span>
              {updateUi.bytesPerSecond > 0 && (
                <>
                  {' · '}
                  <span className="ub-rate">
                    {formatRate(updateUi.bytesPerSecond)}
                  </span>
                </>
              )}
            </>
          )}
        </span>
        <span className="ub-bar" aria-hidden>
          <span
            className={`ub-bar-fill ${starting ? 'is-indeterminate' : ''}`}
            style={starting ? undefined : { width: `${pct}%` }}
          />
        </span>
      </div>
    )
  }

  if (updateUi.kind === 'downloaded') {
    return (
      <div className="update-banner is-downloaded" role="status">
        <span className="ub-icon ub-icon-good" aria-hidden>✓</span>
        <span className="ub-label">
          <strong>v{updateUi.version}</strong> ready
        </span>
        <button
          type="button"
          className="ub-action"
          onClick={() => void window.api.system.installUpdate()}
          title="Quit and install the update now"
        >
          Restart now
        </button>
      </div>
    )
  }

  // error
  return (
    <div className="update-banner is-error" role="alert">
      <span className="ub-icon ub-icon-bad" aria-hidden>!</span>
      <span className="ub-label">
        Update failed
        <span className="ub-detail" title={updateUi.message}>
          {' · '}
          {updateUi.message.length > 60
            ? updateUi.message.slice(0, 57) + '…'
            : updateUi.message}
        </span>
      </span>
      <button
        type="button"
        className="ub-dismiss"
        onClick={clearUpdateUi}
        title="Dismiss"
        aria-label="Dismiss update error"
      >
        ✕
      </button>
    </div>
  )
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`
  const kb = bytesPerSecond / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB/s`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB/s`
}
