// LtcReader: manages an AudioContext, MediaStream, channel splitter, and an
// AudioWorkletProcessor running the LTC decoder. Emits decoded timecode +
// level on callbacks.

const workletUrl = new URL('/ltc-worklet.js', import.meta.url).href

/**
 * Discover the real channel count of an audio input device.
 *
 * Chromium's default WebRTC capture pipeline silently down-mixes everything
 * to stereo, so `channelCount: { ideal: 32 }` lies and gives you 2 on an
 * 8-input device. Getting the truth requires:
 *
 *   1. The main process to launch with `--try-supported-channel-layouts`
 *      (done in `src/main/index.ts`) so Chromium asks the OS for the real
 *      layout instead of forcing stereo.
 *   2. Requesting with `channelCount: { exact: N }` — descending through
 *      plausible counts until the OS accepts one. `exact` throws
 *      OverconstrainedError when the device can't deliver N, which lets
 *      us bracket the real max.
 *
 * Returns the channel count the OS/driver reports for this device. Always
 * at least 1.
 */
const PROBE_CANDIDATES = [64, 32, 24, 16, 12, 10, 8, 6, 4, 3, 2, 1]

async function tryOpen(
  deviceId: string | undefined,
  exactChannels: number,
): Promise<number | null> {
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { exact: exactChannels },
      },
    })
    ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(stream)
    // Trust the source node — Chromium sometimes accepts a constraint but
    // delivers fewer channels anyway.
    return Math.max(1, src.channelCount)
  } catch {
    return null
  } finally {
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* noop */
    }
    try {
      await ctx?.close()
    } catch {
      /* noop */
    }
  }
}

export async function probeDeviceChannelCount(
  deviceId: string | undefined,
): Promise<number> {
  // Walk the candidate list from largest to smallest. First one that opens
  // successfully is the maximum the device will deliver.
  for (const n of PROBE_CANDIDATES) {
    const got = await tryOpen(deviceId, n)
    if (got !== null) {
      // Prefer what the AudioSourceNode actually reports. If it's larger
      // than what we asked for (rare), keep the larger number. If smaller
      // (Chromium downmixed despite 'exact'), keep the smaller one because
      // that's what real capture will give us.
      return got
    }
  }
  return 1
}

export interface LtcReaderEvents {
  onTimecode: (tc: string, df: boolean) => void
  onLevel: (rms: number) => void
  onError: (err: Error) => void
  /** Called once after getUserMedia so the UI knows how many channels the
   *  device actually exposed (may be less than requested). */
  onChannelCount?: (count: number) => void
}

export interface LtcReaderOptions {
  deviceId?: string
  /** 1-indexed channel of the device to decode. Defaults to 1. */
  channel?: number
  /** If known, the exact hardware channel count to request. When omitted
   *  we fall back to probing inside start(). */
  exactChannelCount?: number
}

export class LtcReader {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private stream: MediaStream | null = null

  async start(opts: LtcReaderOptions, handlers: LtcReaderEvents) {
    try {
      // We have to use `{ exact: N }` to defeat Chromium's default stereo
      // downmix. If caller already knows N, use it; otherwise probe the
      // device so we open in the right layout the first time.
      const detected =
        opts.exactChannelCount ??
        (await probeDeviceChannelCount(opts.deviceId))

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { exact: detected },
        },
      })

      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule(workletUrl)

      const source = ctx.createMediaStreamSource(stream)
      const channels = Math.max(1, source.channelCount)
      handlers.onChannelCount?.(channels)

      // Clamp requested channel into the valid range.
      const wanted = Math.max(1, Math.min(channels, opts.channel ?? 1))
      const idx = wanted - 1

      const splitter = ctx.createChannelSplitter(channels)
      source.connect(splitter)

      const node = new AudioWorkletNode(ctx, 'ltc-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        // Make the node accept whatever channel count the single upstream
        // connection provides (a splitter output is single-channel).
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      })
      node.port.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'tc') handlers.onTimecode(msg.tc, msg.df)
        else if (msg.type === 'rms') handlers.onLevel(msg.rms)
      }

      splitter.connect(node, idx, 0)

      this.ctx = ctx
      this.node = node
      this.source = source
      this.splitter = splitter
      this.stream = stream
    } catch (err) {
      handlers.onError(err as Error)
      await this.stop()
    }
  }

  async stop() {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    if (this.splitter) {
      this.splitter.disconnect()
      this.splitter = null
    }
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined)
      this.ctx = null
    }
  }
}
