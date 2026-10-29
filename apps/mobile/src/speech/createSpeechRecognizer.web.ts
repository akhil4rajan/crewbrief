import { RECOGNITION_LANG, type RecognizerCallbacks, type SpeechRecognizer } from "./SpeechRecognizer";

/** Minimal typing for the Web Speech API (not in TypeScript's DOM lib). */
interface WebRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface WebRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<WebRecognitionAlternative> & { isFinal: boolean }>;
}
interface WebRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: WebRecognitionEvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type WebRecognitionCtor = new () => WebRecognition;

function recognitionCtor(): WebRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: WebRecognitionCtor; webkitSpeechRecognition?: WebRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Errors after which restarting just loops (permission or no service). */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "language-not-supported"]);

class BrowserSpeechRecognizer implements SpeechRecognizer {
  readonly available = recognitionCtor() !== null;
  private rec: WebRecognition | null = null;
  private active = false;

  async start(cb: RecognizerCallbacks): Promise<void> {
    const Ctor = recognitionCtor();
    if (!Ctor) throw new Error("Speech recognition isn't supported in this browser.");
    const rec = new Ctor();
    rec.lang = RECOGNITION_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const best = result?.[0];
        if (!result || !best) continue;
        cb.onResult({ text: best.transcript.trim(), confidence: best.confidence || 0.8, isFinal: result.isFinal });
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      if (FATAL_ERRORS.has(ev.error)) this.active = false;
      cb.onError(ev.error === "not-allowed" ? "Microphone permission was denied." : `Speech recognition: ${ev.error}`);
    };
    // Chrome ends continuous recognition after silence or ~60 s; keep it going while active.
    rec.onend = () => {
      if (!this.active) return;
      try {
        rec.start();
      } catch {
        this.active = false;
      }
    };
    this.rec = rec;
    this.active = true;
    rec.start();
  }

  stop(): void {
    this.active = false;
    this.rec?.stop();
    this.rec = null;
  }
}

export function createSpeechRecognizer(): SpeechRecognizer {
  return new BrowserSpeechRecognizer();
}
