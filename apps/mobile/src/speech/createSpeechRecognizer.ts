import type { ExpoSpeechRecognitionModuleType } from "expo-speech-recognition/build/ExpoSpeechRecognitionModule.types";

import { RECOGNITION_LANG, type RecognizerCallbacks, type SpeechRecognizer } from "./SpeechRecognizer";

/**
 * expo-speech-recognition is a native module: present in development/production builds made
 * with its config plugin, absent in Expo Go. Load it lazily so Expo Go falls back to typing.
 */
function loadModule(): ExpoSpeechRecognitionModuleType | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-speech-recognition") as { ExpoSpeechRecognitionModule?: ExpoSpeechRecognitionModuleType };
    return mod.ExpoSpeechRecognitionModule ?? null;
  } catch {
    return null;
  }
}

class NativeSpeechRecognizer implements SpeechRecognizer {
  private readonly mod = loadModule();
  readonly available = this.mod !== null && safeAvailable(this.mod);
  private subs: { remove(): void }[] = [];
  private active = false;

  async start(cb: RecognizerCallbacks): Promise<void> {
    const mod = this.mod;
    if (!mod) throw new Error("On-device speech recognition isn't in this build.");
    const perm = await mod.requestPermissionsAsync();
    if (!perm.granted) throw new Error("Microphone or speech permission was denied.");
    this.subs = [
      mod.addListener("result", (ev) => {
        const best = ev.results[0];
        if (best) cb.onResult({ text: best.transcript.trim(), confidence: best.confidence > 0 ? best.confidence : 0.8, isFinal: ev.isFinal });
      }),
      mod.addListener("error", (ev) => {
        if (ev.error === "no-speech" || ev.error === "aborted") return;
        cb.onError(`Speech recognition: ${ev.message || ev.error}`);
      }),
      // Some recognisers stop after silence even with `continuous`; keep listening while active.
      mod.addListener("end", () => {
        if (this.active) mod.start(this.options());
      }),
    ];
    this.active = true;
    mod.start(this.options());
  }

  stop(): void {
    this.active = false;
    this.mod?.stop();
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }

  private options() {
    return { lang: RECOGNITION_LANG, interimResults: true, continuous: true, addsPunctuation: true };
  }
}

function safeAvailable(mod: ExpoSpeechRecognitionModuleType): boolean {
  try {
    return mod.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export function createSpeechRecognizer(): SpeechRecognizer {
  return new NativeSpeechRecognizer();
}
