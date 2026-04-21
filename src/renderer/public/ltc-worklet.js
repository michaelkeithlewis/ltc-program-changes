/* eslint-disable */
// LTC (Linear Timecode) decoder, running inside an AudioWorkletProcessor.
//
// LTC is SMPTE timecode modulated as biphase-mark (FM) code:
//   - Each bit period contains an edge at the start.
//   - A "1" bit has an extra edge in the middle of the period.
//   - Bit rate = frame_rate * 80  (e.g. 30fps -> 2400 bits/sec).
//
// 80-bit frame layout ends with sync word 0x3FFD which is unique; we shift
// incoming bits into a buffer and look for that sync to align the frame.

const SYNC_BITS = [
  0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1,
];

class LtcProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prevSample = 0;
    this.sampleCount = 0;
    this.lastCrossing = 0;
    this.shortEst = 0;
    this.shortInitialized = false;
    this.pendingShort = false;
    this.bitBuf = [];
    this.dcPrevX = 0;
    this.dcPrevY = 0;
    this.rmsAccum = 0;
    this.rmsCount = 0;
    this.lastEmit = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      // DC-block: y[n] = x[n] - x[n-1] + 0.995 * y[n-1]
      const x = ch[i];
      const y = x - this.dcPrevX + 0.995 * this.dcPrevY;
      this.dcPrevX = x;
      this.dcPrevY = y;

      this.rmsAccum += y * y;
      this.rmsCount += 1;

      if (
        (this.prevSample <= 0 && y > 0) ||
        (this.prevSample >= 0 && y < 0)
      ) {
        const interval = this.sampleCount - this.lastCrossing;
        this.lastCrossing = this.sampleCount;
        if (interval > 1) this.onCrossing(interval);
      }
      this.prevSample = y;
      this.sampleCount++;
    }

    if (this.rmsCount >= sampleRate / 10) {
      const rms = Math.sqrt(this.rmsAccum / this.rmsCount);
      this.port.postMessage({ type: 'rms', rms });
      this.rmsAccum = 0;
      this.rmsCount = 0;
    }

    // Reset tracker on silence so we can re-lock cleanly.
    if (this.sampleCount - this.lastCrossing > sampleRate * 0.5) {
      this.shortInitialized = false;
      this.pendingShort = false;
      this.bitBuf.length = 0;
    }

    return true;
  }

  onCrossing(interval) {
    if (!this.shortInitialized) {
      // Bootstrap: assume half-bit at 30 fps (2400 b/s -> half = sr/4800).
      this.shortEst = sampleRate / (30 * 80 * 2);
      this.shortInitialized = true;
    }

    const shortT = this.shortEst;
    const longT = shortT * 2;
    const isShort = interval < shortT * 1.5;
    const isLong = interval >= shortT * 1.5 && interval < longT * 1.6;

    if (!isShort && !isLong) {
      this.pendingShort = false;
      return;
    }

    if (isShort) {
      if (this.pendingShort) {
        this.pushBit(1);
        this.pendingShort = false;
        this.shortEst = this.shortEst * 0.95 + interval * 0.05;
      } else {
        this.pendingShort = true;
      }
    } else {
      if (this.pendingShort) this.pendingShort = false;
      this.pushBit(0);
      this.shortEst = this.shortEst * 0.95 + (interval / 2) * 0.05;
    }
  }

  pushBit(bit) {
    this.bitBuf.push(bit);
    if (this.bitBuf.length > 80) this.bitBuf.shift();
    if (this.bitBuf.length < 80) return;

    const tail = this.bitBuf.slice(64, 80);
    let match = true;
    for (let i = 0; i < 16; i++) {
      if (tail[i] !== SYNC_BITS[i]) {
        match = false;
        break;
      }
    }
    if (!match) return;

    const frame = parseLtcFrame(this.bitBuf);
    if (frame && currentTime - this.lastEmit > 0.005) {
      this.port.postMessage({ type: 'tc', tc: frame.tc, df: frame.df });
      this.lastEmit = currentTime;
    }
  }
}

function bitsToNumLsb(bits, start, count) {
  let v = 0;
  for (let i = 0; i < count; i++) v |= (bits[start + i] & 1) << i;
  return v;
}

function parseLtcFrame(bits) {
  const frameU = bitsToNumLsb(bits, 0, 4);
  const frameT = bitsToNumLsb(bits, 8, 2);
  const df = bits[10] === 1;
  const secU = bitsToNumLsb(bits, 16, 4);
  const secT = bitsToNumLsb(bits, 24, 3);
  const minU = bitsToNumLsb(bits, 32, 4);
  const minT = bitsToNumLsb(bits, 40, 3);
  const hrU = bitsToNumLsb(bits, 48, 4);
  const hrT = bitsToNumLsb(bits, 56, 2);

  const frames = frameT * 10 + frameU;
  const seconds = secT * 10 + secU;
  const minutes = minT * 10 + minU;
  const hours = hrT * 10 + hrU;

  if (hours > 23 || minutes > 59 || seconds > 59 || frames > 59) return null;

  const pad = (n) => n.toString().padStart(2, '0');
  const sep = df ? ';' : ':';
  const tc = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${sep}${pad(frames)}`;
  return { tc, df };
}

registerProcessor('ltc-processor', LtcProcessor);
