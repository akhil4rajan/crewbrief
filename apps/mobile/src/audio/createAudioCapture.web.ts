import { type AudioCapture, type CaptureCallbacks, FRAME_SAMPLES, TARGET_SAMPLE_RATE } from "./AudioCapture";
import { PCM_WORKLET_NAME, pcmWorkletSource } from "./pcmWorklet";
import { EnergyVad } from "./vad";

/**
 * Browser capture: getUserMedia with the browser's echo cancellation, noise suppression and
 * auto gain, an AudioWorklet that downsamples to 16 kHz PCM16, then the energy VAD so only
 * speech frames are emitted.
 */
class WebAudioCapture implements AudioCapture {
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  readonly sampleRate = TARGET_SAMPLE_RATE;

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private paused = false;
  private readonly vad = new EnergyVad();

  constructor() {
    const hasMedia = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    const hasWorklet = typeof window !== "undefined" && typeof window.AudioWorkletNode === "function";
    this.supported = hasMedia && hasWorklet;
    if (!this.supported) {
      this.unsupportedReason = hasMedia
        ? "This browser can't process audio on the device."
        : "Microphone access isn't available here (it needs HTTPS or localhost).";
    }
  }

  async start(cb: CaptureCallbacks): Promise<void> {
    if (!this.supported) throw new Error(this.unsupportedReason);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    const blobUrl = URL.createObjectURL(
      new Blob([pcmWorkletSource(TARGET_SAMPLE_RATE, FRAME_SAMPLES)], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
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

export function createAudioCapture(): AudioCapture {
  return new WebAudioCapture();
}
