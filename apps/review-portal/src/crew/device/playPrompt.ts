import type { VoicePrompt } from "../../api/types";

const MAX_PLAYBACK_MS = 30_000;

/**
 * Speak a gap prompt to the crew. Azure mode sends synthesised audio (`audio_b64`); local mode
 * sends only text, which is spoken with the browser's speech synthesis. Resolves when playback
 * has finished (or failed, or timed out), so callers can resume listening afterwards.
 */
export async function playPrompt(prompt: VoicePrompt): Promise<void> {
  if (prompt.audio_b64) {
    const mime = (prompt.audio_format ?? "audio/wav").split(";")[0] || "audio/wav";
    if (await playAudio(`data:${mime};base64,${prompt.audio_b64}`)) return;
  }
  await speak(prompt.text);
}

export function stopPrompt(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    // Headless browsers and some devices never fire `end`; cap by a generous reading time.
    const timer = window.setTimeout(resolve, Math.min(MAX_PLAYBACK_MS, 2000 + text.length * 80));
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-AU";
    u.rate = 0.95;
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

function playAudio(uri: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(true), MAX_PLAYBACK_MS);
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      resolve(ok);
    };
    try {
      const el = new Audio(uri);
      el.onended = () => finish(true);
      el.onerror = () => finish(false);
      el.play().catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}
