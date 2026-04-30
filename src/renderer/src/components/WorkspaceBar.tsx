import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store'

/**
 * Sits in the titlebar. Workspace switcher + import/export + reveal folder.
 */
export function WorkspaceBar() {
  const workspaces = useApp((s) => s.workspaces)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const setCues = useApp((s) => s.setCues)
  const setWorkspaces = useApp((s) => s.setWorkspaces)

  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [checkingForUpdates, setCheckingForUpdates] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const current = workspaces.find((w) => w.id === settings?.currentWorkspaceId)

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  useEffect(() => {
    let cancelled = false
    void window.api.system.appVersion().then((v) => {
      if (!cancelled) setAppVersion(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh() {
    const [list, cues, s] = await Promise.all([
      window.api.workspaces.list(),
      window.api.cues.list(),
      window.api.settings.get(),
    ])
    setWorkspaces(list)
    setCues(cues)
    setSettings(s)
  }

  async function switchTo(id: string) {
    setMenuOpen(false)
    if (!id || id === current?.id) return
    await window.api.workspaces.switchTo(id)
    await refresh()
  }

  async function createNew() {
    setMenuOpen(false)
    const name = prompt('Name this show:', 'New show')
    if (!name) return
    await window.api.workspaces.create(name)
    await refresh()
  }

  async function duplicate() {
    setMenuOpen(false)
    if (!current) return
    await window.api.workspaces.duplicate(current.id)
    await refresh()
  }

  async function rename() {
    setMenuOpen(false)
    if (!current) return
    setNewName(current.name)
    setRenameOpen(true)
  }

  async function applyRename() {
    if (!current) return
    setRenameOpen(false)
    await window.api.workspaces.rename(current.id, newName)
    await refresh()
  }

  async function remove() {
    setMenuOpen(false)
    if (!current) return
    if (workspaces.length <= 1) {
      alert('You must keep at least one workspace.')
      return
    }
    if (!confirm(`Delete workspace "${current.name}"? This cannot be undone.`))
      return
    await window.api.workspaces.delete(current.id)
    await refresh()
  }

  async function doExport() {
    setMenuOpen(false)
    if (!current) return
    await window.api.workspaces.exportTo(current.id)
  }

  async function doImport() {
    setMenuOpen(false)
    await window.api.workspaces.importFrom()
    await refresh()
  }

  async function openFolder() {
    setMenuOpen(false)
    await window.api.system.showDataFolder()
  }

  async function checkForUpdates() {
    setMenuOpen(false)
    if (checkingForUpdates) return
    setCheckingForUpdates(true)
    try {
      // Main process surfaces the result via native dialogs (available /
      // up-to-date / error / dev build), so nothing to render here.
      await window.api.system.checkForUpdates()
    } finally {
      setCheckingForUpdates(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        WebkitAppRegion: 'no-drag' as unknown as 'no-drag',
      } as React.CSSProperties}
    >
      <select
        value={current?.id ?? ''}
        onChange={(e) => switchTo(e.target.value)}
        style={{
          padding: '3px 8px',
          fontSize: 12,
          minWidth: 200,
        }}
        title="Switch workspace"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · {w.cueCount} cue{w.cueCount === 1 ? '' : 's'}
          </option>
        ))}
      </select>

      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          style={{ padding: '3px 10px', fontSize: 12 }}
          onClick={() => setMenuOpen((o) => !o)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            style={{
              position: 'absolute',
              top: '110%',
              right: 0,
              minWidth: 220,
              background: 'var(--bg-3)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 4,
              boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
              zIndex: 100,
            }}
          >
            <MenuItem label="New show…" onClick={createNew} />
            <MenuItem label="Rename current…" onClick={rename} />
            <MenuItem label="Duplicate" onClick={duplicate} />
            <Separator />
            <MenuItem label="Export current…" onClick={doExport} />
            <MenuItem label="Import from file…" onClick={doImport} />
            <Separator />
            <MenuItem label="Reveal data folder" onClick={openFolder} />
            <Separator />
            <MenuItem
              label={
                checkingForUpdates ? 'Checking for updates…' : 'Check for updates…'
              }
              onClick={checkForUpdates}
              disabled={checkingForUpdates}
            />
            <Separator />
            <MenuItem
              label="Delete current…"
              onClick={remove}
              danger
              disabled={workspaces.length <= 1}
            />
            {appVersion && (
              <>
                <Separator />
                <div
                  style={{
                    padding: '4px 10px 2px',
                    fontSize: 11,
                    color: 'var(--muted, #888)',
                    textAlign: 'right',
                  }}
                >
                  v{appVersion}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {renameOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
          }}
          onClick={() => setRenameOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 20,
              minWidth: 320,
            }}
          >
            <div style={{ marginBottom: 10 }}>Rename workspace</div>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyRename()
                if (e.key === 'Escape') setRenameOpen(false)
              }}
              style={{ width: '100%' }}
            />
            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: 12,
              }}
            >
              <button onClick={() => setRenameOpen(false)}>Cancel</button>
              <button className="primary" onClick={applyRename}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        fontSize: 12,
        color: danger ? 'var(--bad)' : 'var(--text)',
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  )
}

function Separator() {
  return (
    <div
      style={{
        height: 1,
        background: 'var(--border)',
        margin: '4px 0',
      }}
    />
  )
}
