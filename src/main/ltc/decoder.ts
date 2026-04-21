/**
 * LTC (Linear Timecode) decoder, feed-oriented. Identical algorithm to the
 * former AudioWorklet but runs in plain Node code so we can drive it with
 * raw PCM samples pulled from RtAudio.
 *
 * Feed float samples (one channel, normalised to roughly [-1, 1]) via
 * `pushSamples(buf, sampleRate)`. Decoded frames arrive via the `onFrame`
 * callback.
 */

const SYNC_BITS = [
  0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1,
]

export interface DecodedFrame {
  tc: string // "HH:MM:SS:FF" or "HH:MM:SS;FF" for drop-frame
  df: boolean
}

export type FrameCallback = (f: DecodedFrame) => void
export type LevelCallback = (rms: number) => void

export class LtcDecoder {
  private prevSample = 0
  private sampleCount = 0
  private lastCrossing = 0
  private shortEst = 0
  private shortInitialized = false
  private pendingShort = false
  private bitBuf: number[] = []
  private dcPrevX = 0
  private dcPrevY = 0
  private rmsAccum = 0
  private rmsCount = 0
  private lastEmitAt = 0

  constructor(
    private onFrame: FrameCallback,
    private onLevel?: LevelCallback,
  ) {}

  reset() {
    this.prevSample = 0
    this.sampleCount = 0
    this.lastCrossing = 0
    this.shortEst = 0
    this.shortInitialized = false
    this.pendingShort = false
    this.bitBuf = []
    this.dcPrevX = 0
    this.dcPrevY = 0
    this.rmsAccum = 0
    this.rmsCount = 0
    this.lastEmitAt = 0
  }

  pushSamples(samples: Float32Array | number[], sampleRate: number) {
    const levelInterval = Math.floor(sampleRate / 10)
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]
      // DC-block: y[n] = x[n] - x[n-1] + 0.995 * y[n-1]
      const y = x - this.dcPrevX + 0.995 * this.dcPrevY
      this.dcPrevX = x
      this.dcPrevY = y

      this.rmsAccum += y * y
      this.rmsCount += 1

      if ((this.prevSample <= 0 && y > 0) || (this.prevSample >= 0 && y < 0)) {
        const interval = this.sampleCount - this.lastCrossing
        this.lastCrossing = this.sampleCount
        if (interval > 1) this.onCrossing(interval, sampleRate)
      }
      this.prevSample = y
      this.sampleCount++

      if (this.rmsCount >= levelInterval) {
        const rms = Math.sqrt(this.rmsAccum / this.rmsCount)
        this.onLevel?.(rms)
        this.rmsAccum = 0
        this.rmsCount = 0
      }
    }

    // Sync/tracker recovery on silence.
    if (this.sampleCount - this.lastCrossing > sampleRate * 0.5) {
      this.shortInitialized = false
      this.pendingShort = false
      this.bitBuf.length = 0
    }
  }

  private onCrossing(interval: number, sampleRate: number) {
    if (!this.shortInitialized) {
      // Bootstrap: assume half-bit at 30 fps (2400 b/s → half = sr/4800).
      this.shortEst = sampleRate / (30 * 80 * 2)
      this.shortInitialized = true
    }

    const shortT = this.shortEst
    const longT = shortT * 2
    const isShort = interval < shortT * 1.5
    const isLong = interval >= shortT * 1.5 && interval < longT * 1.6

    if (!isShort && !isLong) {
      this.pendingShort = false
      return
    }

    if (isShort) {
      if (this.pendingShort) {
        this.pushBit(1)
        this.pendingShort = false
        this.shortEst = this.shortEst * 0.95 + interval * 0.05
      } else {
        this.pendingShort = true
      }
    } else {
      if (this.pendingShort) this.pendingShort = false
      this.pushBit(0)
      this.shortEst = this.shortEst * 0.95 + (interval / 2) * 0.05
    }
  }

  private pushBit(bit: number) {
    this.bitBuf.push(bit)
    if (this.bitBuf.length > 80) this.bitBuf.shift()
    if (this.bitBuf.length < 80) return

    const tail = this.bitBuf.slice(64, 80)
    let match = true
    for (let i = 0; i < 16; i++) {
      if (tail[i] !== SYNC_BITS[i]) {
        match = false
        break
      }
    }
    if (!match) return

    const frame = parseLtcFrame(this.bitBuf)
    if (!frame) return
    // Throttle emits to avoid hammering IPC.
    const now = this.sampleCount
    if (now - this.lastEmitAt < 48) return
    this.lastEmitAt = now
    this.onFrame(frame)
  }
}

function bitsToNumLsb(bits: number[], start: number, count: number): number {
  let v = 0
  for (let i = 0; i < count; i++) v |= (bits[start + i] & 1) << i
  return v
}

function parseLtcFrame(bits: number[]): DecodedFrame | null {
  const frameU = bitsToNumLsb(bits, 0, 4)
  const frameT = bitsToNumLsb(bits, 8, 2)
  const df = bits[10] === 1
  const secU = bitsToNumLsb(bits, 16, 4)
  const secT = bitsToNumLsb(bits, 24, 3)
  const minU = bitsToNumLsb(bits, 32, 4)
  const minT = bitsToNumLsb(bits, 40, 3)
  const hrU = bitsToNumLsb(bits, 48, 4)
  const hrT = bitsToNumLsb(bits, 56, 2)

  const frames = frameT * 10 + frameU
  const seconds = secT * 10 + secU
  const minutes = minT * 10 + minU
  const hours = hrT * 10 + hrU

  if (hours > 23 || minutes > 59 || seconds > 59 || frames > 59) return null

  const pad = (n: number) => n.toString().padStart(2, '0')
  const sep = df ? ';' : ':'
  return {
    tc: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${sep}${pad(frames)}`,
    df,
  }
}
