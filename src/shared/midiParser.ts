/**
 * Incrementally parse raw MIDI bytes arriving from a TCP stream into
 * message-level events. Handles running status, SysEx (skipped), realtime
 * bytes interleaved inside channel messages, and fragmented reads.
 */

export type ParsedMessage =
  | { kind: 'noteOn'; channel: number; note: number; velocity: number; bytes: number[] }
  | { kind: 'noteOff'; channel: number; note: number; velocity: number; bytes: number[] }
  | { kind: 'cc'; channel: number; controller: number; value: number; bytes: number[] }
  | { kind: 'programChange'; channel: number; program: number; bytes: number[] }
  | { kind: 'pitchBend'; channel: number; value: number; bytes: number[] }
  | { kind: 'channelPressure'; channel: number; value: number; bytes: number[] }
  | { kind: 'polyPressure'; channel: number; note: number; pressure: number; bytes: number[] }
  | { kind: 'sysex'; bytes: number[] }
  | { kind: 'realtime'; status: number; bytes: number[] }
  | { kind: 'unknown'; bytes: number[] }

/**
 * Lookup of (expected data bytes) for each channel status upper nibble.
 * 0x80..0xE0 are channel messages. 0xC0 and 0xD0 take 1 data byte; the rest
 * take 2. Channel number is (status & 0x0F) + 1 (1..16, human).
 */
const DATA_BYTES: Record<number, number> = {
  0x80: 2, // note off
  0x90: 2, // note on
  0xa0: 2, // poly aftertouch
  0xb0: 2, // CC
  0xc0: 1, // program change
  0xd0: 1, // channel aftertouch
  0xe0: 2, // pitch bend
}

export class MidiStreamParser {
  private runningStatus: number | null = null
  private data: number[] = []
  private sysex = false
  private sysexBuf: number[] = []

  /**
   * Feed raw bytes; returns zero or more parsed messages. Unfinished messages
   * are buffered until more bytes arrive.
   */
  push(bytes: number[]): ParsedMessage[] {
    const out: ParsedMessage[] = []

    for (const b of bytes) {
      // Realtime bytes (0xF8..0xFF) can appear anywhere, even inside other
      // messages. Surface them but don't disturb the parser state.
      if (b >= 0xf8) {
        out.push({ kind: 'realtime', status: b, bytes: [b] })
        continue
      }

      if (this.sysex) {
        if (b === 0xf7) {
          this.sysexBuf.push(0xf7)
          out.push({ kind: 'sysex', bytes: this.sysexBuf })
          this.sysexBuf = []
          this.sysex = false
        } else if (b & 0x80) {
          // Any non-realtime status byte terminates sysex abruptly.
          this.sysex = false
          out.push({ kind: 'sysex', bytes: this.sysexBuf })
          this.sysexBuf = []
          // Reprocess this byte as a new status byte below.
          this.handleStatus(b, out)
        } else {
          this.sysexBuf.push(b)
        }
        continue
      }

      if (b & 0x80) {
        this.handleStatus(b, out)
      } else {
        this.handleDataByte(b, out)
      }
    }

    return out
  }

  private handleStatus(b: number, out: ParsedMessage[]) {
    if (b === 0xf0) {
      this.sysex = true
      this.sysexBuf = [0xf0]
      this.data = []
      this.runningStatus = null
      return
    }
    if (b >= 0xf1 && b <= 0xf7) {
      // System common messages — we don't use them; emit as unknown.
      out.push({ kind: 'unknown', bytes: [b] })
      this.data = []
      this.runningStatus = null
      return
    }
    // Channel voice/mode message status byte.
    this.runningStatus = b
    this.data = []
  }

  private handleDataByte(b: number, out: ParsedMessage[]) {
    if (this.runningStatus === null) return // orphan data byte, ignore
    this.data.push(b)
    const type = this.runningStatus & 0xf0
    const needed = DATA_BYTES[type]
    if (needed === undefined) {
      this.runningStatus = null
      this.data = []
      return
    }
    if (this.data.length < needed) return
    const msg = assembleMessage(this.runningStatus, this.data)
    if (msg) out.push(msg)
    this.data = []
    // Keep running status for the next message of the same type.
  }
}

function assembleMessage(status: number, data: number[]): ParsedMessage | null {
  const type = status & 0xf0
  const channel = (status & 0x0f) + 1
  const bytes = [status, ...data]
  switch (type) {
    case 0x80:
      return {
        kind: 'noteOff',
        channel,
        note: data[0],
        velocity: data[1],
        bytes,
      }
    case 0x90:
      return data[1] === 0
        ? { kind: 'noteOff', channel, note: data[0], velocity: 0, bytes }
        : {
            kind: 'noteOn',
            channel,
            note: data[0],
            velocity: data[1],
            bytes,
          }
    case 0xa0:
      return {
        kind: 'polyPressure',
        channel,
        note: data[0],
        pressure: data[1],
        bytes,
      }
    case 0xb0:
      return {
        kind: 'cc',
        channel,
        controller: data[0],
        value: data[1],
        bytes,
      }
    case 0xc0:
      return { kind: 'programChange', channel, program: data[0], bytes }
    case 0xd0:
      return { kind: 'channelPressure', channel, value: data[0], bytes }
    case 0xe0:
      return {
        kind: 'pitchBend',
        channel,
        value: (data[1] << 7) | data[0],
        bytes,
      }
    default:
      return null
  }
}

export function messageChannel(m: ParsedMessage): number | null {
  if ('channel' in m) return m.channel
  return null
}

export function messageLabel(m: ParsedMessage): string {
  switch (m.kind) {
    case 'noteOn':
      return `Note On ${m.note} vel=${m.velocity} ch${m.channel}`
    case 'noteOff':
      return `Note Off ${m.note} vel=${m.velocity} ch${m.channel}`
    case 'cc':
      return `CC${m.controller}=${m.value} ch${m.channel}`
    case 'programChange':
      return `PC=${m.program} ch${m.channel}`
    case 'pitchBend':
      return `PitchBend=${m.value} ch${m.channel}`
    case 'channelPressure':
      return `ChPressure=${m.value} ch${m.channel}`
    case 'polyPressure':
      return `PolyPressure ${m.note}=${m.pressure} ch${m.channel}`
    case 'sysex':
      return `SysEx (${m.bytes.length}B)`
    case 'realtime':
      return `Realtime 0x${m.status.toString(16).toUpperCase()}`
    case 'unknown':
      return `Unknown`
  }
}
