import { type AudioCapture, TARGET_SAMPLE_RATE } from "./AudioCapture";

/**
 * Native (iOS/Android, managed Expo): expo-audio records to compressed files and exposes no
 * live PCM buffer, so raw 16 kHz frames can't be streamed from Expo Go or a plain dev build.
 * The device therefore runs in text mode (on-device speech recognition or typed input). A
 * custom native module or `react-native-audio-api`-style streaming recorder can implement this
 * interface later without touching the rest of the app; see apps/mobile/README.md.
 */
class UnsupportedNativeCapture implements AudioCapture {
  readonly supported = false;
  readonly unsupportedReason = "Live audio streaming needs a custom native build; using on-device speech.";
  readonly sampleRate = TARGET_SAMPLE_RATE;

  async start(): Promise<void> {
    throw new Error(this.unsupportedReason);
  }
  pause(): void {}
  resume(): void {}
  async stop(): Promise<void> {}
}

export function createAudioCapture(): AudioCapture {
  return new UnsupportedNativeCapture();
}
