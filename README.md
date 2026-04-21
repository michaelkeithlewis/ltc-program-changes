# LTC Program Changes → Allen & Heath dLive

A standalone desktop app that takes **SMPTE LTC (Linear Timecode)** from an
audio input, fires **MIDI Program Change** messages at user-defined timecode
values, and sends them over **TCP** to an Allen & Heath **dLive** rack (via
the built-in MIDI-over-TCP network bridge).

It also includes a **simulator** (no real audio required) and a **live MIDI
monitor** for debugging, plus clear **connection status detection** so you
can verify the link to the mixer at a glance.

![status](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)

## Features

- **LTC audio decoder** — Web Audio `AudioWorklet` that decodes SMPTE
  biphase-mark timecode (24 / 25 / 29.97 / 30 fps).
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

## Running in development

```bash
npm install
npm run dev
```

## Packaging a standalone app

```bash
npm run dist        # produces installers in ./dist
# or
npm run package     # unpacked app directory
```

Targets: `.dmg` on macOS, `.exe` (NSIS) on Windows, `.AppImage` on Linux.

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
