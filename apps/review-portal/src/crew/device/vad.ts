/**
 * Energy-based voice activity detector with an adaptive noise floor, pre-roll and hangover.
 *
 * Why this simple: the browser/OS already does noise suppression; the VAD only has to stop
 * silence and steady background noise (idling truck, wind) from being streamed. A frame is
 * speech when its RMS is well above the tracked noise floor. Hangover keeps short pauses
 * between words inside one utterance; pre-roll keeps the soft start of the first word.
 */
export interface VadOptions {
  /** Speech when rms > noiseFloor * ratio (and above minRms). */
  ratio: number;
  minRms: number;
  /** Frames to keep sending after energy drops (20 ms frames → 15 = 300 ms). */
  hangoverFrames: number;
  /** Frames buffered before speech onset and sent with it. */
  preRollFrames: number;
}

const DEFAULTS: VadOptions = { ratio: 3, minRms: 0.01, hangoverFrames: 15, preRollFrames: 10 };

export class EnergyVad {
  private noiseFloor = 0.005;
  private hangover = 0;
  private preRoll: Int16Array[] = [];
  private readonly opts: VadOptions;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Returns the frames to send for this input frame (empty during silence). */
  process(frame: Int16Array): { frames: Int16Array[]; rms: number; speaking: boolean } {
    const rms = rmsOf(frame);
    const loud = rms > Math.max(this.opts.minRms, this.noiseFloor * this.opts.ratio);

    if (!loud) {
      // Track the floor quickly downwards and slowly upwards, only outside speech.
      const alpha = rms < this.noiseFloor ? 0.2 : 0.01;
      this.noiseFloor = this.noiseFloor * (1 - alpha) + rms * alpha;
    }

    if (loud) {
      const frames = this.hangover > 0 ? [frame] : [...this.preRoll, frame];
      this.preRoll = [];
      this.hangover = this.opts.hangoverFrames;
      return { frames, rms, speaking: true };
    }
    if (this.hangover > 0) {
      this.hangover -= 1;
      return { frames: [frame], rms, speaking: true };
    }
    this.preRoll.push(frame);
    if (this.preRoll.length > this.opts.preRollFrames) this.preRoll.shift();
    return { frames: [], rms, speaking: false };
  }

  reset(): void {
    this.hangover = 0;
    this.preRoll = [];
  }
}

function rmsOf(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]! / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}
