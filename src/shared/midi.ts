import type { Cue, ProgramChangeCue, Timecode } from './types'

export function clampChannel(ch: number): number {
  if (ch < 1) return 1
  if (ch > 16) return 16
  return Math.floor(ch)
}

/**
 * Build MIDI bytes for a Program Change cue. If bank MSB/LSB are provided we
 * emit CC0 and CC32 ahead of the PC.
 */
export function buildProgramChange(cue: ProgramChangeCue): number[] {
  const status = 0xc0 | (clampChannel(cue.channel) - 1)
  const cc = 0xb0 | (clampChannel(cue.channel) - 1)
  const out: number[] = []
  if (cue.bankMsb !== undefined) out.push(cc, 0x00, cue.bankMsb & 0x7f)
  if (cue.bankLsb !== undefined) out.push(cc, 0x20, cue.bankLsb & 0x7f)
  out.push(status, cue.program & 0x7f)
  return out
}

export function buildCueBytes(cue: Cue): number[] {
  return buildProgramChange(cue)
}

/**
 * Convert an Allen & Heath dLive **scene number** (1..500) to its MIDI
 * representation per the dLive MIDI protocol: Bank Select CC0 =
 * floor((s-1)/128), then Program Change = (s-1) % 128. Scene 129 is
 * CC0=1 + PC 0.
 */
export function sceneToPcFields(scene: number): {
  bankMsb: number
  program: number
} {
  const s = clampScene(scene)
  const idx = s - 1
  return {
    bankMsb: Math.floor(idx / 128) & 0x7f,
    program: idx % 128,
  }
}

/** dLive scene number a cue recalls. Cues without a bank are bank 0. */
export function cueToScene(cue: Pick<Cue, 'program' | 'bankMsb'>): number {
  return (cue.bankMsb ?? 0) * 128 + (cue.program & 0x7f) + 1
}

export function clampScene(scene: number): number {
  return Math.max(1, Math.min(500, Math.floor(scene) || 1))
}

export function bytesToLabel(bytes: number[]): string {
  const parts: string[] = []
  let i = 0
  while (i < bytes.length) {
    const s = bytes[i]
    const type = s & 0xf0
    const ch = (s & 0x0f) + 1
    if (type === 0xb0 && i + 2 < bytes.length) {
      const cc = bytes[i + 1]
      const v = bytes[i + 2]
      if (cc === 0) parts.push(`CC0(MSB)=${v} ch${ch}`)
      else if (cc === 32) parts.push(`CC32(LSB)=${v} ch${ch}`)
      else parts.push(`CC${cc}=${v} ch${ch}`)
      i += 3
    } else if (type === 0xc0 && i + 1 < bytes.length) {
      parts.push(`PC=${bytes[i + 1]} ch${ch}`)
      i += 2
    } else {
      parts.push(`0x${s.toString(16)}`)
      i += 1
    }
  }
  return parts.join(' + ')
}

export function formatBytesHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

// --- Timecode helpers -----------------------------------------------------

export function parseTimecode(s: string): Timecode | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[:;](\d{1,2})$/)
  if (!m) return null
  const tc: Timecode = {
    hours: parseInt(m[1], 10),
    minutes: parseInt(m[2], 10),
    seconds: parseInt(m[3], 10),
    frames: parseInt(m[4], 10),
    dropFrame: s.includes(';'),
  }
  if (
    tc.hours < 0 ||
    tc.hours > 23 ||
    tc.minutes < 0 ||
    tc.minutes > 59 ||
    tc.seconds < 0 ||
    tc.seconds > 59 ||
    tc.frames < 0 ||
    tc.frames > 59
  )
    return null
  return tc
}

export function formatTimecode(tc: Timecode): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const sep = tc.dropFrame ? ';' : ':'
  return `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}${sep}${pad(tc.frames)}`
}

/**
 * Live auto-formatter for timecode entry. Designed to be invoked from a
 * controlled-input `onChange` handler so the value the user sees stays in
 * lockstep with their typing.
 *
 * Behaviour:
 * - Strips any non-digit characters (colons, semicolons, letters, etc.) and
 *   then re-inserts a `:` after every two digits. So `12345678` becomes
 *   `12:34:56:78` and the user can keep typing past a "full" segment — the
 *   extra digit auto-flows into the next field rather than getting silently
 *   eaten by a per-segment clamp.
 * - Capped at 8 digits / 4 segments. Anything past `FF` is dropped.
 *
 * Note: this means pasting a partial value like `1:23:45:00` will be
 * re-grouped as `12:34:50:0` rather than treating the colons as canonical.
 * Pasting a fully-padded value (`01:23:45:00`) round-trips correctly. The
 * trade-off favours smooth left-to-right typing over honouring partial
 * colon hints in pastes, which testing showed was the right priority.
 *
 * Use `normalizeTimecodeInput` on blur to pad short segments to two digits
 * and back-fill missing fields with `00`.
 */
export function autoFormatTimecodeInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  if (digits.length === 0) return ''
  const groups: string[] = []
  for (let i = 0; i < digits.length; i += 2) {
    groups.push(digits.slice(i, i + 2))
  }
  return groups.join(':')
}

/**
 * Final pass for timecode input (call from `onBlur`). Pads each segment to
 * two digits and back-fills missing trailing segments with `00`, so a
 * partial entry like `12:34` becomes the full `12:34:00:00`. Returns the
 * empty string if the input contains no digits at all (lets the user clear
 * a cue's TC by emptying the field).
 */
export function normalizeTimecodeInput(raw: string): string {
  const formatted = autoFormatTimecodeInput(raw)
  if (!formatted) return ''
  const dropFrame = raw.includes(';')
  const parts = formatted.split(/[:;]/).map((p) => p.padStart(2, '0'))
  while (parts.length < 4) parts.push('00')
  const sep = dropFrame ? ';' : ':'
  return `${parts[0]}:${parts[1]}:${parts[2]}${sep}${parts[3]}`
}

export function timecodeToFrames(tc: Timecode, fps: number): number {
  // Simple non-drop-frame calc for scheduling comparisons.
  const f = Math.round(fps)
  return ((tc.hours * 60 + tc.minutes) * 60 + tc.seconds) * f + tc.frames
}

export function timecodeToMs(tc: Timecode, fps: number): number {
  return (timecodeToFrames(tc, fps) / fps) * 1000
}
