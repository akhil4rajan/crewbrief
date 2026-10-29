/**
 * AudioWorklet that turns the mic stream (usually 44.1/48 kHz float) into 16 kHz PCM16 mono
 * frames. It runs on the audio thread, so it is plain JS loaded from a Blob URL (no bundler
 * involvement). Downsampling averages each output sample's input window, which acts as a
 * cheap low-pass filter against aliasing.
 */
export const PCM_WORKLET_NAME = "crewbrief-pcm16";

export function pcmWorkletSource(targetRate: number, frameSamples: number): string {
  return `
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${targetRate};
    this.pending = [];      // input samples not yet consumed
    this.out = new Int16Array(${frameSamples});
    this.outLen = 0;
    this.frac = 0;          // fractional read position carried between calls
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const chans = input.length;
    for (let i = 0; i < ch0.length; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += input[c][i];
      this.pending.push(s / chans);
    }
    const ratio = this.ratio;
    let pos = this.frac;
    while (pos + ratio <= this.pending.length) {
      const start = Math.floor(pos);
      const end = Math.floor(pos + ratio);
      let acc = 0;
      for (let j = start; j < end; j++) acc += this.pending[j];
      const v = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)));
      this.out[this.outLen++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.outLen === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(${frameSamples});
        this.outLen = 0;
      }
      pos += ratio;
    }
    const consumed = Math.floor(pos);
    this.pending = this.pending.slice(consumed);
    this.frac = pos - consumed;
    return true;
  }
}
registerProcessor("${PCM_WORKLET_NAME}", Pcm16Downsampler);
`;
}
