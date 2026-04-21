// LtcReader: manages an AudioContext, input MediaStream, and AudioWorklet
// running the LTC decoder. Emits decoded timecode + level to callbacks.

// The worklet is shipped as plain JS under renderer/public so it can be
// loaded by AudioWorklet.addModule() without bundler transforms.
const workletUrl = new URL('/ltc-worklet.js', import.meta.url).href

export interface LtcReaderEvents {
  onTimecode: (tc: string, df: boolean) => void
  onLevel: (rms: number) => void
  onError: (err: Error) => void
}

export class LtcReader {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null

  async start(deviceId: string | undefined, handlers: LtcReaderEvents) {
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule(workletUrl)

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      })

      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'ltc-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      node.port.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'tc') handlers.onTimecode(msg.tc, msg.df)
        else if (msg.type === 'rms') handlers.onLevel(msg.rms)
      }
      source.connect(node)

      this.ctx = ctx
      this.node = node
      this.source = source
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
