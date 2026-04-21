import { EventEmitter } from 'node:events'
import { RtAudio } from 'audify'
import { LtcDecoder, type DecodedFrame } from './decoder'

// RtAudio format constant. We use the runtime numeric value rather than the
// TS `declare const enum` import so we don't depend on `isolatedModules`
// behaviour and so this module never fails to resolve at runtime.
const RTAUDIO_FLOAT32 = 0x10

export interface AudioDeviceInfo {
  id: number
  name: string
  inputChannels: number
  preferredSampleRate: number
  sampleRates: number[]
  isDefaultInput: boolean
}

export interface AudioStatus {
  running: boolean
  deviceId: number | null
  deviceName: string | null
  channel: number | null // 1-indexed
  channelCount: number | null
  sampleRate: number | null
  /** Incremented each time the watchdog has to resync the decoder. */
  resyncs?: number
  /** Incremented each time the audio stream had to be rebuilt. */
  streamRestarts?: number
  /** Running count of frames parsed but dropped by the corroboration filter. */
  rejectedFrames?: number
}

export interface StartOptions {
  deviceId: number
  /** 1-indexed channel to decode. */
  channel: number
}

/**
 * Native multi-channel audio capture driving the LTC decoder.
 *
 * Uses RtAudio (via `audify`) so we bypass Chromium's WebRTC capture
 * pipeline entirely — getUserMedia clamps every input to stereo, which
 * makes multi-channel interfaces like Dante Virtual Soundcard unusable
 * from the renderer side.
 */
export class AudioService extends EventEmitter {
  private rt: RtAudio | null = null
  private decoder: LtcDecoder | null = null
  private watchdog: NodeJS.Timeout | null = null
  private lastStartOpts: StartOptions | null = null
  private lastFrameAt = 0
  private lastCallbackAt = 0
  private lastLevel = 0
  private lastRestartAt = 0
  private lastResyncAt = 0
  private resyncCount = 0
  private streamRestarts = 0

  /**
   * Watchdog safety intervals — kept generous so the auto-recovery path
   * can't become its own failure mode. A stream restart takes real time
   * (RtAudio device init) and briefly blocks the event loop, so we
   * absolutely don't want to do it more than once every few seconds.
   */
  private static readonly MIN_RESTART_INTERVAL_MS = 5000
  private static readonly MIN_RESYNC_INTERVAL_MS = 1500
  private status: AudioStatus = {
    running: false,
    deviceId: null,
    deviceName: null,
    channel: null,
    channelCount: null,
    sampleRate: null,
    resyncs: 0,
    streamRestarts: 0,
  }

  getStatus(): AudioStatus {
    return this.status
  }

  listDevices(): AudioDeviceInfo[] {
    const rt = new RtAudio()
    try {
      return rt
        .getDevices()
        .filter((d) => d.inputChannels > 0)
        .map((d) => ({
          id: d.id,
          name: d.name,
          inputChannels: d.inputChannels,
          preferredSampleRate: d.preferredSampleRate,
          sampleRates: d.sampleRates,
          isDefaultInput: !!d.isDefaultInput,
        }))
    } finally {
      // RtAudio cleans itself up on GC; explicit close not required when no
      // stream is open.
    }
  }

  start(opts: StartOptions) {
    this.stop()
    this.lastStartOpts = opts
    this.openStream(opts)
    this.startWatchdog()
  }

  private openStream(opts: StartOptions) {
    const rt = new RtAudio()
    const devices = rt.getDevices()
    const device = devices.find((d) => d.id === opts.deviceId)
    if (!device) throw new Error(`Audio device ${opts.deviceId} not found`)
    if (device.inputChannels < 1)
      throw new Error(`${device.name} has no input channels`)

    const channel = Math.max(1, Math.min(device.inputChannels, opts.channel))
    const channelCount = device.inputChannels
    const sampleRate =
      device.preferredSampleRate || device.sampleRates[0] || 48000

    const bufferFrames = Math.max(256, Math.floor(sampleRate / 50))

    const decoder = new LtcDecoder(
      (frame: DecodedFrame) => {
        this.lastFrameAt = Date.now()
        this.emit('frame', frame)
      },
      (rms: number) => {
        this.lastLevel = rms
        this.emit('level', rms)
      },
    )

    const scratch = new Float32Array(bufferFrames)
    const chIndex = channel - 1

    rt.openStream(
      null,
      {
        deviceId: device.id,
        nChannels: channelCount,
        firstChannel: 0,
      },
      RTAUDIO_FLOAT32,
      sampleRate,
      bufferFrames,
      'ltc-program-changes',
      (pcm: Buffer) => {
        this.lastCallbackAt = Date.now()
        const view = new Float32Array(
          pcm.buffer,
          pcm.byteOffset,
          pcm.byteLength / 4,
        )
        const frames = view.length / channelCount
        for (let i = 0; i < frames; i++) {
          scratch[i] = view[i * channelCount + chIndex]
        }
        decoder.pushSamples(scratch.subarray(0, frames), sampleRate)
      },
      null,
    )
    rt.start()

    this.rt = rt
    this.decoder = decoder
    // Give the watchdog a grace period before it starts second-guessing things.
    const now = Date.now()
    this.lastFrameAt = now
    this.lastCallbackAt = now
    this.lastLevel = 0
    this.status = {
      running: true,
      deviceId: device.id,
      deviceName: device.name,
      channel,
      channelCount,
      sampleRate,
      resyncs: this.resyncCount,
      streamRestarts: this.streamRestarts,
      rejectedFrames: 0,
    }
    this.emit('status', this.status)
  }

  /**
   * Periodic health check. Two failure modes we recover from automatically:
   *
   *   1. Decoder drift — audio is flowing and there's actual signal, but
   *      no valid LTC frame has come out for a while. Happens when the
   *      short-bit estimator gets nudged out of its tracking range by a
   *      burst of noise or a tone. Soft-reset the decoder in place so its
   *      next zero crossing rebootstraps it. No audible disruption.
   *
   *   2. Audio callback hang — RtAudio's input callback has gone quiet
   *      entirely (can happen if the device sample clock disappears, a
   *      Dante stream drops, or the OS reroutes the default device out
   *      from under us). Tear the stream down and re-open it.
   *
   * Previously the only recovery path was the user manually hitting
   * Stop → Start, which is exactly what this replaces.
   */
  private startWatchdog() {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      if (!this.rt || !this.decoder) return
      const now = Date.now()
      const sinceCb = now - this.lastCallbackAt
      const sinceFrame = now - this.lastFrameAt

      // Surface rejected-frame count in status so the UI can show the
      // user when the corroboration filter is actively catching errors.
      const rejected = this.decoder.rejectedFrames()
      if (rejected !== (this.status.rejectedFrames ?? 0)) {
        this.status = { ...this.status, rejectedFrames: rejected }
        this.emit('status', this.status)
      }

      if (
        sinceCb > 3000 &&
        now - this.lastRestartAt > AudioService.MIN_RESTART_INTERVAL_MS
      ) {
        this.lastRestartAt = now
        this.streamRestarts += 1
        this.emit('warning', {
          kind: 'stream-stalled',
          message: `Audio callback silent for ${sinceCb}ms — restarting stream`,
        })
        this.restartStream()
        return
      }

      // Only treat "no frames" as a problem if there's actually signal on
      // the selected channel. No signal == nothing to decode, not a bug.
      const hasSignal = this.lastLevel > 0.004
      if (
        sinceFrame > 1500 &&
        hasSignal &&
        now - this.lastResyncAt > AudioService.MIN_RESYNC_INTERVAL_MS
      ) {
        this.lastResyncAt = now
        this.resyncCount += 1
        this.decoder.softReset()
        this.lastFrameAt = now
        this.status = {
          ...this.status,
          resyncs: this.resyncCount,
        }
        this.emit('status', this.status)
        this.emit('warning', {
          kind: 'decoder-resynced',
          message: 'LTC decoder lost lock — resynced in place',
        })
      }
    }, 500)
  }

  private stopWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  private restartStream() {
    if (!this.lastStartOpts) return
    const opts = this.lastStartOpts
    try {
      if (this.rt) {
        try {
          this.rt.stop()
        } catch {
          /* noop */
        }
        try {
          this.rt.closeStream()
        } catch {
          /* noop */
        }
      }
    } finally {
      this.rt = null
      this.decoder = null
    }
    try {
      this.openStream(opts)
      this.status = {
        ...this.status,
        streamRestarts: this.streamRestarts,
      }
      this.emit('status', this.status)
    } catch (e) {
      this.emit('warning', {
        kind: 'stream-restart-failed',
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** Manual knob the UI exposes so users can kick the decoder without a full stop/start. */
  resync(): AudioStatus {
    if (this.decoder) {
      this.resyncCount += 1
      this.decoder.softReset()
      this.lastFrameAt = Date.now()
      this.status = { ...this.status, resyncs: this.resyncCount }
      this.emit('status', this.status)
    }
    return this.status
  }

  stop() {
    this.stopWatchdog()
    this.lastStartOpts = null
    if (this.rt) {
      try {
        this.rt.stop()
      } catch {
        /* noop */
      }
      try {
        this.rt.closeStream()
      } catch {
        /* noop */
      }
      this.rt = null
    }
    this.decoder = null
    this.resyncCount = 0
    this.streamRestarts = 0
    if (this.status.running) {
      this.status = {
        running: false,
        deviceId: null,
        deviceName: null,
        channel: null,
        channelCount: null,
        sampleRate: null,
        resyncs: 0,
        streamRestarts: 0,
      }
      this.emit('status', this.status)
    }
  }
}
