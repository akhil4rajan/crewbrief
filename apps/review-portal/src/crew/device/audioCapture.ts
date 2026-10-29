import { EnergyVad } from "./vad";

/** Target format agreed with the gateway: PCM16 little-endian, mono, 16 kHz. */
export const TARGET_SAMPLE_RATE = 16_000;
/** Static AudioWorklet (public/pcm16-worklet.js): downsamples to 16 kHz PCM16, 20 ms frames. */
const WORKLET_URL = "/pcm16-worklet.js";
const WORKLET_NAME = "crewbrief-pcm16";

export interface CaptureCallbacks {
  /** A VAD-gated speech frame (Int16 PCM, little-endian). */
  onFrame(pcm: ArrayBuffer): void;
  /** Input level 0..1 and whether the VAD currently considers this speech; for the UI meter. */
  onLevel?(level: number, speaking: boolean): void;
}

/** Why the browser cannot stream raw PCM, or null when it can. */
export function audioUnsupportedReason(): string | null {
  const hasMedia = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const hasWorklet = typeof window !== "undefined" && typeof window.AudioWorkletNode === "function";
  if (hasMedia && hasWorklet) return null;
  return hasMedia
    ? "This browser can't process audio on the device."
    : "Microphone access isn't available here (it needs HTTPS or localhost).";
}

/**
 * Browser microphone capture: getUserMedia with echo cancellation, noise suppression and auto
 * gain, an AudioWorklet that downsamples to 16 kHz PCM16, then an energy VAD so only speech
 * frames leave the device.
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private paused = false;
  private readonly vad = new EnergyVad();

  async start(cb: CaptureCallbacks): Promise<void> {
    const reason = audioUnsupportedReason();
    if (reason) throw new Error(reason);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.paused) return;
      const { frames, rms, speaking } = this.vad.process(new Int16Array(ev.data));
      cb.onLevel?.(Math.min(1, rms * 4), speaking);
      for (const f of frames) cb.onFrame(f.buffer as ArrayBuffer);
    };
    // Route through a muted gain to the destination so every engine keeps pulling the graph.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute).connect(ctx.destination);
    this.node = node;
    if (ctx.state === "suspended") await ctx.resume();
  }

  pause(): void {
    this.paused = true;
    this.vad.reset();
  }

  resume(): void {
    this.paused = false;
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
