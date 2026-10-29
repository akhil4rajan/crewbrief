import { createAudioPlayer } from "expo-audio";
import * as Speech from "expo-speech";
import { Platform } from "react-native";

import type { VoicePrompt } from "@/api/types";

const MAX_PLAYBACK_MS = 30_000;

/**
 * Speak a gap prompt to the crew. Azure mode sends synthesised audio (`audio_b64`); local mode
 * sends only text, which is spoken with on-device TTS. Resolves when playback has finished (or
 * failed), so the caller can resume on-device speech recognition without transcribing the
 * prompt itself.
 */
export async function playPrompt(prompt: VoicePrompt): Promise<void> {
  if (prompt.audio_b64) {
    const ok = await playAudio(`data:${audioMime(prompt.audio_format)};base64,${prompt.audio_b64}`);
    if (ok) return;
  }
  await speak(prompt.text);
}

export function stopPrompt(): void {
  Speech.stop();
}

function audioMime(format: string | null | undefined): string {
  return (format ?? "audio/wav").split(";")[0] || "audio/wav";
}

function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, MAX_PLAYBACK_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    Speech.speak(text, { language: "en-AU", rate: 0.95, onDone: done, onStopped: done, onError: done });
  });
}

function playAudio(uri: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), MAX_PLAYBACK_MS);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      if (Platform.OS === "web") {
        const el = new Audio(uri);
        el.onended = () => finish(true);
        el.onerror = () => finish(false);
        el.play().catch(() => finish(false));
        return;
      }
      const player = createAudioPlayer(uri);
      const sub = player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) {
          sub.remove();
          player.remove();
          finish(true);
        }
      });
      player.play();
    } catch {
      finish(false);
    }
  });
}
