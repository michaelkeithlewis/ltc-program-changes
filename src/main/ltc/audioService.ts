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
  private status: AudioStatus = {
    running: false,
    deviceId: null,
    deviceName: null,
    channel: null,
    channelCount: null,
    sampleRate: null,
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

    // 960 samples @ 48 kHz = 20 ms per callback — snappy enough for TC.
    const bufferFrames = Math.max(256, Math.floor(sampleRate / 50))

    const decoder = new LtcDecoder(
      (frame: DecodedFrame) => this.emit('frame', frame),
      (rms: number) => this.emit('level', rms),
    )

    // Scratch buffer reused across callbacks to extract the chosen channel.
    const scratch = new Float32Array(bufferFrames)
    const chIndex = channel - 1

    rt.openStream(
      null, // no output
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
        // Interleaved Float32. Extract the one channel we care about.
        const view = new Float32Array(
          pcm.buffer,
          pcm.byteOffset,
          pcm.byteLength / 4,
        )
        const frames = view.length / channelCount
        for (let i = 0; i < frames; i++) {
          scratch[i] = view[i * channelCount + chIndex]
        }
        // Note: we only push `frames` real samples even if scratch is larger.
        decoder.pushSamples(scratch.subarray(0, frames), sampleRate)
      },
      null, // no output callback
    )
    rt.start()

    this.rt = rt
    // `decoder` is held alive by the input callback closure.
    void decoder
    this.status = {
      running: true,
      deviceId: device.id,
      deviceName: device.name,
      channel,
      channelCount,
      sampleRate,
    }
    this.emit('status', this.status)
  }

  stop() {
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
    if (this.status.running) {
      this.status = {
        running: false,
        deviceId: null,
        deviceName: null,
        channel: null,
        channelCount: null,
        sampleRate: null,
      }
      this.emit('status', this.status)
    }
  }
}
