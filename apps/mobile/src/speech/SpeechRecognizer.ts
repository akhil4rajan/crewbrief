export interface RecognitionResult {
  text: string;
  confidence: number;
  isFinal: boolean;
}

export interface RecognizerCallbacks {
  onResult(result: RecognitionResult): void;
  onError(message: string): void;
}

/**
 * On-device speech-to-text used in `text` mode (no cloud STT, e.g. local development).
 * Implementations keep listening continuously until `stop()`, restarting the platform
 * recogniser when it ends on its own after silence.
 */
export interface SpeechRecognizer {
  readonly available: boolean;
  start(callbacks: RecognizerCallbacks): Promise<void>;
  stop(): void;
}

export const RECOGNITION_LANG = "en-AU";
