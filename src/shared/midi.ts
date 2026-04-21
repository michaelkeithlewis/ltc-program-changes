import type { Cue, DliveSceneCue, ProgramChangeCue, Timecode } from './types'

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

/**
 * Allen & Heath dLive scene recall over MIDI:
 *   Bank Select MSB (CC0)  = 0
 *   Bank Select LSB (CC32) = floor((scene-1) / 128)   // 0..3
 *   Program Change        = (scene-1) % 128           // 0..127
 * Valid scenes: 1..500.
 */
export function buildDliveSceneRecall(cue: DliveSceneCue): number[] {
  const scene = Math.max(1, Math.min(500, Math.floor(cue.scene)))
  const idx = scene - 1
  const bankLsb = Math.floor(idx / 128) & 0x7f
  const program = idx % 128
  const cc = 0xb0 | (clampChannel(cue.channel) - 1)
  const pc = 0xc0 | (clampChannel(cue.channel) - 1)
  return [cc, 0x00, 0x00, cc, 0x20, bankLsb, pc, program]
}

export function buildCueBytes(cue: Cue): number[] {
  return cue.type === 'dliveScene'
    ? buildDliveSceneRecall(cue)
    : buildProgramChange(cue)
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

export function timecodeToFrames(tc: Timecode, fps: number): number {
  // Simple non-drop-frame calc for scheduling comparisons.
  const f = Math.round(fps)
  return ((tc.hours * 60 + tc.minutes) * 60 + tc.seconds) * f + tc.frames
}

export function timecodeToMs(tc: Timecode, fps: number): number {
  return (timecodeToFrames(tc, fps) / fps) * 1000
}
