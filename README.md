# LTC Program Changes → Allen & Heath dLive

A standalone desktop app that takes **SMPTE LTC (Linear Timecode)** from an
audio input, fires **MIDI Program Change** messages at user-defined timecode
values, and sends them over **TCP** to an Allen & Heath **dLive** rack (via
the built-in MIDI-over-TCP network bridge).

It also includes a **simulator** (no real audio required) and a **live MIDI
monitor** for debugging, plus clear **connection status detection** so you
can verify the link to the mixer at a glance.

![status](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
[![latest release](https://img.shields.io/github/v/release/michaelkeithlewis/ltc-program-changes?include_prereleases&sort=semver)](https://github.com/michaelkeithlewis/ltc-program-changes/releases/latest)

## Download

Grab the latest installer for your platform from the
[**Releases page**](https://github.com/michaelkeithlewis/ltc-program-changes/releases/latest):

| Platform             | File                                    |
| -------------------- | --------------------------------------- |
| macOS (Apple silicon) | `LTC Program Changes-*-arm64.dmg`       |
| macOS (Intel)         | `LTC Program Changes-*.dmg` (x64)       |
| Windows              | `LTC Program Changes Setup *.exe`       |
| Linux                | `LTC Program Changes-*.AppImage`        |

The app checks for updates automatically on startup and every few hours, and
will prompt before downloading a new version.

### First-launch notes

**macOS** — the DMG is signed with a Developer ID certificate and notarized
by Apple, so it opens normally with no Gatekeeper warning. Drag the app to
Applications and launch it.

**Windows** — the installer is currently **unsigned**, so Windows
SmartScreen will warn *"Windows protected your PC"* on first run. Click
**More info → Run anyway** to proceed. Subsequent launches don't warn.

**Linux** — make the AppImage executable, then run it:

```bash
chmod +x LTC\ Program\ Changes-*.AppImage
./LTC\ Program\ Changes-*.AppImage
```

## Features

- **LTC audio decoder** — native multi-channel capture (CoreAudio / WASAPI /
  ASIO / ALSA via RtAudio) feeding a Node-side biphase-mark decoder for
  24 / 25 / 29.97 / 30 fps SMPTE LTC. Bypasses the browser's WebRTC stack,
  so interfaces like Dante Virtual Soundcard expose all their channels
  (up to 64 in / 64 out).
- **Cue list** — `HH:MM:SS:FF` → MIDI Program Change (or full dLive Scene
  Recall: Bank MSB + Bank LSB + PC). Auto-persisted.
- **dLive TCP client** — connects to the dLive MIDI bridge with auto-reconnect
  and a light-weight Active Sensing heartbeat so the connection indicator is
  trustworthy.
- **Simulator** — runs a virtual timecode clock so cues can be tested without
  live LTC. Also has a manual "fire now" panel for any scene / PC number.
- **MIDI monitor** — every outgoing and incoming byte, with hex + semantic
  label (e.g. `CC0(MSB)=0 + CC32(LSB)=1 + PC=42 ch1`).
- **Connection status** — pill with live state (`connected`, `connecting`,
  `error`, `disconnected`) and remote address.

## dLive setup

1. In **Director** (or on the Surface), enable **Network MIDI**:  
   `Utility → Control → MIDI → Network MIDI: Enabled`
2. Set the TCP port (default **51325**) and confirm the mixer's IP address.
3. Make sure **Scenes / Softkeys** are configured to listen for MIDI Scene
   Recall or Program Change.
4. In this app:
   - Enter the dLive IP + port
   - Click **Connect** — the status pill turns green when the TCP session is
     established.

## Prerequisites

- **Node.js 20+** (22 recommended)
- A working native-module toolchain for [`audify`](https://github.com/almoghamdani/audify):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: "Desktop development with C++" workload in Visual Studio Build Tools, Python 3
  - **Linux**: `build-essential`, `libasound2-dev`, `python3`

## Running in development

```bash
npm install
npm run dev
```

## Packaging a standalone app

```bash
npm run dist:mac      # .dmg (universal: arm64 + x64)
npm run dist:win      # .exe NSIS installer
npm run dist:linux    # .AppImage
npm run dist:app      # unpacked .app directory (no installer)
npm run dist:all      # build for macOS, Windows, and Linux in one shot
```

Output lands in `./dist`. Targets: `.dmg` on macOS, `.exe` (NSIS) on Windows,
`.AppImage` on Linux.

### Code-signing (optional)

By default the committed config builds **unsigned** so anyone can package
locally without certificates. To produce a signed + notarized macOS build,
set these env vars before `npm run dist:mac`:

```bash
export CSC_LINK=/path/to/DeveloperID.p12          # or a base64 data URL
export CSC_KEY_PASSWORD=...
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-abcd-abcd-abcd
export APPLE_TEAM_ID=XXXXXXXXXX
npx electron-builder --mac dmg -c.mac.notarize=true
```

The same secrets, wired into GitHub Actions, produce signed installers
automatically on every tagged release — see
[`.github/workflows/release.yml`](.github/workflows/release.yml).

## Releasing (maintainer workflow)

```bash
npm version patch        # or minor / major — bumps package.json + tags
git push --follow-tags
```

Pushing a `v*` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Builds `.dmg` (macOS, arm64 + x64), `.exe` (Windows NSIS), and
   `.AppImage` (Linux) on the matching runners.
2. Collects the installers plus the `latest*.yml` metadata files that
   `electron-updater` needs.
3. Creates a **draft** GitHub Release with auto-generated release notes and
   attaches everything.

Review the draft on the Releases page and click **Publish release** when
ready. Published assets become the new auto-update target for every existing
installed copy.

### Dry-run a release

From the Actions tab, run the **Release** workflow manually with
`dry_run: true`. The workflow builds installers and uploads them as workflow
artifacts without creating or updating a Release — handy for smoke-testing a
build before tagging.

## Audio input

Connect your LTC source (e.g. Pro Tools LTC out, video-playback LTC feed) to
any audio input on the machine running this app. Inside the app:

1. Click **Start Listening**.
2. Pick the audio input device.
3. The timecode display turns blue and updates live when LTC is locked.

LTC must be at a reasonable level (≈ −12 to 0 dBFS works well). The input
level meter next to the device selector shows signal presence.

## Cue types

| Type               | Bytes emitted                                                      |
| ------------------ | ------------------------------------------------------------------ |
| **dLive Scene**    | `B0 00 00` (Bank MSB=0) `B0 20 <lsb>` (Bank LSB) `C0 <pc>` (PC)    |
| **Program Change** | Optional `B0 00 <msb>` / `B0 20 <lsb>`, then `C0 <pc>`             |

The dLive scene mapping follows A&H's spec: scene number `N` (1..500) maps to
`Bank LSB = floor((N-1)/128)` and `Program = (N-1) % 128`.

## Architecture

```
┌───────────── Electron Renderer (React) ─────────────┐
│  AudioWorklet (LTC decoder)  ──► Cue scheduler ─┐   │
│  Simulator (virtual TC)   ───────────────────►──┤   │
│  Cue list / Monitor / Connection UI             │   │
└──────────────────────────────┬──────────────────┘   │
                               │ IPC (contextBridge)  │
┌──────────────────────────────▼───────────────────────┐
│  Electron Main (Node)                                │
│  DliveClient: TCP socket, reconnect, heartbeat       │
│  JSON store: cues + settings                         │
└──────────────────────────────┬───────────────────────┘
                               │ TCP (port 51325)
                               ▼
                       Allen & Heath dLive
```

## Notes / known limits

- Drop-frame handling in the cue scheduler uses simple non-drop math; if you
  work in 29.97 DF and need sub-second-precise alignment over long durations,
  prefer 30 fps NDF on your LTC feed.
- The LTC decoder auto-adapts to fps based on bit timing. If you see jitter,
  ensure the audio input is not being processed (disable echo-cancellation,
  AGC, etc. — the app already requests these off).
- This app is **one-way** MIDI (app → dLive). Incoming TCP data is logged for
  debugging but not interpreted.
