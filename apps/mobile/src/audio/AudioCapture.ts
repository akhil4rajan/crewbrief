/** Target format agreed with the gateway: PCM16 little-endian, mono, 16 kHz. */
export const TARGET_SAMPLE_RATE = 16_000;
/** 20 ms frames: small enough for low latency, large enough to keep message overhead sane. */
export const FRAME_SAMPLES = 320;

export interface CaptureCallbacks {
  /** A VAD-gated speech frame (Int16 PCM, little-endian). */
  onFrame(pcm: ArrayBuffer): void;
  /** Input level 0..1 and whether the VAD currently considers this speech; for the UI meter. */
  onLevel?(level: number, speaking: boolean): void;
}

/**
 * Microphone capture with on-device noise suppression and voice activity detection, so only
 * speech leaves the device. Implementations are per platform (see createAudioCapture*.ts).
 */
export interface AudioCapture {
  /** False when this platform/build cannot stream raw PCM (the app then uses text mode). */
  readonly supported: boolean;
  /** Why streaming is unsupported, for the UI. */
  readonly unsupportedReason?: string;
  readonly sampleRate: number;
  start(callbacks: CaptureCallbacks): Promise<void>;
  /** Keep the mic open but stop emitting frames (consent: recording paused). */
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}
