// LtcReader: manages an AudioContext, MediaStream, channel splitter, and an
// AudioWorkletProcessor running the LTC decoder. Emits decoded timecode +
// level on callbacks.

const workletUrl = new URL('/ltc-worklet.js', import.meta.url).href

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
}

export class LtcReader {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private stream: MediaStream | null = null

  async start(opts: LtcReaderOptions, handlers: LtcReaderEvents) {
    try {
      // Ask for as many channels as the device will give us. Browsers cap
      // this to whatever the OS reports for the device; we'll use the real
      // count from the source node below.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 32 },
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
