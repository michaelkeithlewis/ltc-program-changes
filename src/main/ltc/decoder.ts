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

/**
 * Confirmation window, in nominal milliseconds at 30 fps. A newly decoded
 * frame is only emitted once a SECOND decoded frame corroborates it —
 * meaning the two candidates differ by a small, plausible temporal delta.
 * This blocks random bit-flip errors (a single-bit flip in an otherwise
 * valid LTC frame can change the TC by seconds while still passing the
 * range check) from ever reaching the cue firing logic.
 *
 * Cost: one frame of latency, ~33 ms. Well below human perception.
 */
const CORROBORATION_MAX_FORWARD_MS = 400 // ~12 frames at 30 fps
const CORROBORATION_MAX_REVERSE_MS = 200 // covers reverse-playback LTC

function frameToMs(f: DecodedFrame): number {
  // Use 30 fps nominal for comparison — we only need a stable monotonic mapping.
  const m = f.tc.match(/^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/)
  if (!m) return 0
  const hh = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const ss = parseInt(m[3], 10)
  const ff = parseInt(m[4], 10)
  return (((hh * 60 + mm) * 60 + ss) * 1000) + Math.round((ff / 30) * 1000)
}

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
  private pendingFrame: DecodedFrame | null = null
  private lastEmittedFrameMs = -1
  private rejectedCount = 0

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
    this.pendingFrame = null
    this.lastEmittedFrameMs = -1
    this.rejectedCount = 0
  }

  /**
   * Resync without tearing down DC filter state or the sample clock.
   * Meant for the watchdog path: we see continuous audio but no sync words,
   * which usually means the short-bit estimator drifted. Wipe the bit buffer
   * and force a fresh bootstrap on the next zero crossing.
   */
  softReset() {
    this.shortEst = 0
    this.shortInitialized = false
    this.pendingShort = false
    this.bitBuf = []
    this.lastEmitAt = 0
    this.pendingFrame = null
    // Keep lastEmittedFrameMs so post-resync frames still get deduped against
    // the last good emit; the confirmation step will gate bogus values.
  }

  /** How many frames parsed but rejected by the corroboration filter since last reset. */
  rejectedFrames(): number {
    return this.rejectedCount
  }

  /** Sample index at which we last emitted a decoded frame (0 if never). */
  lastFrameSample(): number {
    return this.lastEmitAt
  }

  /** Current sample index — useful for watchdog "is it still progressing" checks. */
  currentSample(): number {
    return this.sampleCount
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
    const now = this.sampleCount
    if (now - this.lastEmitAt < 48) return
    this.lastEmitAt = now
    this.emitWithConfirmation(frame)
  }

  /**
   * Two-frame rolling corroboration. A freshly parsed frame is held as
   * `pendingFrame`; it's only handed up to `onFrame` once the NEXT parsed
   * frame arrives and lands within a plausible temporal window relative
   * to it. If the second frame is wildly inconsistent, the old pending
   * is discarded (it was likely corrupt) and the new one takes its slot.
   *
   * Effect on bit errors: a lone bad frame never reaches consumers. A
   * correlated burst of bad frames that happens to be self-consistent
   * would still slip through, but that's vanishingly rare in practice
   * for LTC.
   *
   * Effect on real seeks: two consecutive frames at the new position
   * will naturally corroborate, so a seek is accepted after one frame
   * of confirmation latency (~33 ms at 30 fps).
   */
  private emitWithConfirmation(frame: DecodedFrame) {
    const pending = this.pendingFrame
    if (!pending) {
      this.pendingFrame = frame
      return
    }

    const pendingMs = frameToMs(pending)
    const frameMs = frameToMs(frame)
    const delta = frameMs - pendingMs
    const consistent =
      delta >= -CORROBORATION_MAX_REVERSE_MS &&
      delta <= CORROBORATION_MAX_FORWARD_MS

    if (consistent) {
      // Confirmed. Emit the pending frame (if different from last emit).
      if (pendingMs !== this.lastEmittedFrameMs) {
        this.onFrame(pending)
        this.lastEmittedFrameMs = pendingMs
      }
      this.pendingFrame = frame
    } else {
      // Disagreement: pending was likely a single-bit error or glitch.
      // Drop it, keep the newer frame as the next pending candidate.
      this.rejectedCount += 1
      this.pendingFrame = frame
    }
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
