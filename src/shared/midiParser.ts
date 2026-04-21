/**
 * Incrementally parse raw MIDI bytes arriving from a TCP stream into
 * message-level events. Handles running status, SysEx (skipped), realtime
 * bytes interleaved inside channel messages, and fragmented reads.
 */

export type ParsedMessage =
  | { kind: 'noteOn'; channel: number; note: number; velocity: number; bytes: number[] }
  | { kind: 'noteOff'; channel: number; note: number; velocity: number; bytes: number[] }
  | { kind: 'cc'; channel: number; controller: number; value: number; bytes: number[] }
  | {
      kind: 'nrpn'
      channel: number
      param: number // 14-bit NRPN address (MSB<<7 | LSB)
      value: number // 7-bit or 14-bit depending on whether LSB data followed
      bytes: number[]
    }
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

/**
 * Per-channel NRPN assembler state. dLive (and most large consoles) emit
 * surface changes as a storm of NRPN triplets:
 *
 *   CC 99  = NRPN Parameter MSB
 *   CC 98  = NRPN Parameter LSB
 *   CC  6  = Data Entry MSB       (optionally followed by CC 38 LSB)
 *
 * We collapse each of those triplets into a single `nrpn` message so the
 * log reads as one event instead of three, and so downstream consumers
 * (the monitor, any filtering, IPC batching) do 3x less work during
 * scene recalls. Stale state (partial triplet where someone sent a CC6
 * with no preceding 99/98) is discarded — we only emit `nrpn` when the
 * full address was observed.
 */
interface NrpnState {
  msb?: number
  lsb?: number
  msbBytes?: number[]
  lsbBytes?: number[]
}

export class MidiStreamParser {
  private runningStatus: number | null = null
  private data: number[] = []
  private sysex = false
  private sysexBuf: number[] = []
  private nrpn = new Map<number, NrpnState>()

  /**
   * Feed raw bytes; returns zero or more parsed messages. Unfinished messages
   * are buffered until more bytes arrive.
   */
  push(bytes: number[]): ParsedMessage[] {
    const raw: ParsedMessage[] = []

    for (const b of bytes) {
      if (b >= 0xf8) {
        raw.push({ kind: 'realtime', status: b, bytes: [b] })
        continue
      }

      if (this.sysex) {
        if (b === 0xf7) {
          this.sysexBuf.push(0xf7)
          raw.push({ kind: 'sysex', bytes: this.sysexBuf })
          this.sysexBuf = []
          this.sysex = false
        } else if (b & 0x80) {
          this.sysex = false
          raw.push({ kind: 'sysex', bytes: this.sysexBuf })
          this.sysexBuf = []
          this.handleStatus(b, raw)
        } else {
          this.sysexBuf.push(b)
        }
        continue
      }

      if (b & 0x80) {
        this.handleStatus(b, raw)
      } else {
        this.handleDataByte(b, raw)
      }
    }

    // Post-process: fold CC 99/98/6 triplets into NRPN events.
    return this.coalesceNrpn(raw)
  }

  /**
   * Walk the freshly-parsed stream in order, collapsing CC99→CC98→CC06
   * sequences into single `nrpn` events per channel. Any CC on the NRPN
   * controllers (99/98/6/38) is consumed by this pass — other CCs and
   * all non-CC messages pass through unchanged.
   */
  private coalesceNrpn(input: ParsedMessage[]): ParsedMessage[] {
    const out: ParsedMessage[] = []
    for (const m of input) {
      if (m.kind !== 'cc') {
        out.push(m)
        continue
      }
      const state = this.getNrpn(m.channel)
      switch (m.controller) {
        case 99: // Parameter MSB
          state.msb = m.value
          state.msbBytes = m.bytes.slice()
          state.lsb = undefined
          state.lsbBytes = undefined
          break
        case 98: // Parameter LSB
          state.lsb = m.value
          state.lsbBytes = m.bytes.slice()
          break
        case 6: // Data Entry MSB — commits the current NRPN address
          if (state.msb !== undefined && state.lsb !== undefined) {
            const addr = (state.msb << 7) | state.lsb
            const wire = [
              ...(state.msbBytes ?? []),
              ...(state.lsbBytes ?? []),
              ...m.bytes,
            ]
            out.push({
              kind: 'nrpn',
              channel: m.channel,
              param: addr,
              value: m.value,
              bytes: wire,
            })
          } else {
            // Orphan CC6 — keep as a raw CC so it's not silently lost.
            out.push(m)
          }
          break
        case 38: // Data Entry LSB — fine-grained follow-up, fold into last NRPN
          if (out.length > 0 && out[out.length - 1].kind === 'nrpn') {
            const last = out[out.length - 1] as Extract<
              ParsedMessage,
              { kind: 'nrpn' }
            >
            last.value = (last.value << 7) | m.value
            last.bytes = [...last.bytes, ...m.bytes]
          } else {
            out.push(m)
          }
          break
        default:
          out.push(m)
      }
    }
    return out
  }

  private getNrpn(channel: number): NrpnState {
    let s = this.nrpn.get(channel)
    if (!s) {
      s = {}
      this.nrpn.set(channel, s)
    }
    return s
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
    case 'nrpn':
      return `NRPN ${m.param}=${m.value} ch${m.channel}`
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
