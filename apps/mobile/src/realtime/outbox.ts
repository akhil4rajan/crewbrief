import AsyncStorage from "@react-native-async-storage/async-storage";

import type { DeviceClientMessage } from "@/api/types";

/**
 * Outgoing device messages that could not be sent yet. Text messages (typed or recognised
 * speech, pause/resume/end) are persisted so they survive the app being closed in a dead zone;
 * audio stays in memory only, capped by duration, because raw audio must not be stored by
 * default (privacy) and is large.
 */
export const MAX_BUFFERED_AUDIO_MS = 120_000;

type QueuedItem = { kind: "json"; msg: DeviceClientMessage } | { kind: "audio"; data: ArrayBuffer; durationMs: number };

const storageKey = (sessionId: string) => `crewbrief.outbox.${sessionId}`;

export class Outbox {
  private items: QueuedItem[] = [];
  private audioMs = 0;
  private droppedAudioMs = 0;

  /** Resolves once messages persisted by a previous run are back in the queue. */
  readonly restored: Promise<void>;

  constructor(private readonly sessionId: string) {
    this.restored = this.restore();
  }

  private async restore(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(storageKey(this.sessionId));
      if (!raw) return;
      const saved = JSON.parse(raw) as DeviceClientMessage[];
      this.items = [...saved.map((msg) => ({ kind: "json" as const, msg })), ...this.items];
    } catch {
      // Corrupt or unavailable storage: start with an empty queue rather than crash.
    }
  }

  get size(): number {
    return this.items.length;
  }

  get bufferedAudioMs(): number {
    return this.audioMs;
  }

  get droppedAudio(): number {
    return this.droppedAudioMs;
  }

  pushJson(msg: DeviceClientMessage): void {
    this.items.push({ kind: "json", msg });
    void this.persist();
  }

  pushAudio(data: ArrayBuffer, durationMs: number): void {
    this.items.push({ kind: "audio", data, durationMs });
    this.audioMs += durationMs;
    // Drop the oldest audio first; text messages are never dropped.
    while (this.audioMs > MAX_BUFFERED_AUDIO_MS) {
      const idx = this.items.findIndex((i) => i.kind === "audio");
      if (idx < 0) break;
      const [removed] = this.items.splice(idx, 1);
      if (removed?.kind === "audio") {
        this.audioMs -= removed.durationMs;
        this.droppedAudioMs += removed.durationMs;
      }
    }
  }

  /** Discard buffered audio, e.g. when switching to text mode where audio can't be used. */
  dropAudio(): void {
    this.items = this.items.filter((i) => i.kind !== "audio");
    this.audioMs = 0;
  }

  /** Send everything in order; stops at the first failure and keeps the rest queued. */
  flush(send: (item: QueuedItem) => boolean): void {
    while (this.items.length > 0) {
      const item = this.items[0]!;
      if (!send(item)) break;
      this.items.shift();
      if (item.kind === "audio") this.audioMs -= item.durationMs;
    }
    void this.persist();
  }

  private async persist(): Promise<void> {
    // Never overwrite the stored queue before it has been read back.
    await this.restored;
    const json = this.items.filter((i) => i.kind === "json").map((i) => (i as { msg: DeviceClientMessage }).msg);
    try {
      if (json.length === 0) await AsyncStorage.removeItem(storageKey(this.sessionId));
      else await AsyncStorage.setItem(storageKey(this.sessionId), JSON.stringify(json));
    } catch {
      // Persistence is best-effort; the in-memory queue still flushes on reconnect.
    }
  }
}

export type { QueuedItem };
