import type {
  CaptureMode,
  DeviceClientMessage,
  DeviceControlMessage,
  EventEnvelope,
} from "@/api/types";
import { gatewayWsUrl } from "@/config";
import { Outbox } from "./outbox";

export type ConnectionState = "connecting" | "online" | "reconnecting" | "closed";

export interface ConnectionInfo {
  state: ConnectionState;
  queued: number;
  bufferedAudioMs: number;
  attempt: number;
  /** Set when the socket gave up for good (auth failure, session over). */
  closedReason?: string;
}

export interface DeviceSocketOptions {
  sessionId: string;
  deviceId: string;
  sampleRate: number;
  getToken: () => string | null;
  onEvent: (event: EventEnvelope) => void;
  onControl?: (msg: DeviceControlMessage) => void;
  onConnection: (info: ConnectionInfo) => void;
  /** Called after a reconnect (not the first connect), so callers can re-sync missed state. */
  onReconnected?: () => void;
}

const PING_INTERVAL_MS = 15_000;
const READY_FALLBACK_MS = 2_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** Close codes after which retrying cannot help (policy/auth, or the gateway's 44xx app codes). */
/** Audio frames arrive ~50/s; connection info for them is reported at most this often. */
const AUDIO_EMIT_INTERVAL_MS = 500;
const FATAL_CLOSE = (code: number) => code === 1008 || (code >= 4400 && code < 4500);

/**
 * The crew device's link to the gateway (`/ws/device/{id}`). Owns reconnection with exponential
 * backoff + jitter, the `start` handshake on every (re)connect, and the offline outbox: anything
 * sent while disconnected is queued and flushed in order once the gateway says `ready`.
 */
export class DeviceSocket {
  private ws: WebSocket | null = null;
  private readonly outbox: Outbox;
  private mode: CaptureMode = "audio";
  private paused = false;
  private ready = false;
  private attempt = 0;
  private everConnected = false;
  private stopped = false;
  private closedReason: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ConnectionState = "connecting";
  private lastAudioEmit = 0;

  constructor(private readonly opts: DeviceSocketOptions) {
    this.outbox = new Outbox(opts.sessionId);
  }

  async connect(mode: CaptureMode): Promise<void> {
    this.mode = mode;
    await this.outbox.restored;
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", this.handleBrowserOnline);
    }
    this.open();
  }

  /** Close for good (briefing ended or screen left). Text still queued stays persisted. */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", this.handleBrowserOnline);
    }
    this.ws?.close(1000, "client closing");
    this.ws = null;
    this.setState("closed");
  }

  get currentMode(): CaptureMode {
    return this.mode;
  }

  /** Switch capture mode, e.g. to `text` when the gateway cannot transcribe audio. */
  setMode(mode: CaptureMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "text") this.outbox.dropAudio();
    if (this.isOpen()) this.rawSend(this.startMessage());
    this.emit();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.send(paused ? { type: "pause" } : { type: "resume" });
  }

  send(msg: DeviceClientMessage): void {
    if (this.ready && this.outbox.size === 0 && this.rawSend(msg)) return;
    this.outbox.pushJson(msg);
    this.emit();
  }

  sendAudio(frame: ArrayBuffer): void {
    if (this.mode !== "audio") return;
    const durationMs = (frame.byteLength / 2 / this.opts.sampleRate) * 1000;
    if (this.ready && this.outbox.size === 0 && this.rawSend(frame)) return;
    this.outbox.pushAudio(frame, durationMs);
    const now = Date.now();
    if (now - this.lastAudioEmit >= AUDIO_EMIT_INTERVAL_MS) {
      this.lastAudioEmit = now;
      this.emit();
    }
  }

  // --- internals ---------------------------------------------------------------------------

  private open(): void {
    if (this.stopped) return;
    const token = this.opts.getToken();
    if (!token) {
      this.giveUp("Signed out");
      return;
    }
    this.setState(this.everConnected ? "reconnecting" : "connecting");
    const url = gatewayWsUrl(`/ws/device/${encodeURIComponent(this.opts.sessionId)}?access_token=${encodeURIComponent(token)}`);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.rawSend(this.startMessage());
      if (this.paused) this.rawSend({ type: "pause" });
      // Older gateways may not send `ready`; don't hold the queue hostage forever.
      this.readyTimer = setTimeout(() => this.markReady(), READY_FALLBACK_MS);
      this.pingTimer = setInterval(() => this.rawSend({ type: "ping" }), PING_INTERVAL_MS);
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    ws.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearTimers();
      if (this.stopped) return;
      if (FATAL_CLOSE(ev.code)) {
        this.giveUp(ev.reason || `Connection refused (${ev.code})`);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: { type?: string; payload?: unknown };
    try {
      msg = JSON.parse(data) as { type?: string; payload?: unknown };
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.markReady();
      this.opts.onControl?.(msg as DeviceControlMessage);
    } else if (msg.type === "pong") {
      return;
    } else if ("payload" in msg && "session_id" in msg) {
      this.opts.onEvent(msg as EventEnvelope);
    } else if (msg.type === "error") {
      // Bare error frame (not an envelope): normalise to the envelope shape for callers.
      const bare = msg as unknown as { code: string; message?: string };
      this.opts.onEvent({
        id: "local",
        type: "error",
        session_id: this.opts.sessionId,
        ts: new Date().toISOString(),
        payload: { code: bare.code, message: bare.message },
      });
    }
  }

  private markReady(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.ready || !this.isOpen()) return;
    this.ready = true;
    const wasReconnect = this.everConnected;
    this.everConnected = true;
    this.attempt = 0;
    this.outbox.flush((item) => (item.kind === "json" ? this.rawSend(item.msg) : this.rawSend(item.data)));
    this.setState("online");
    if (wasReconnect) this.opts.onReconnected?.();
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1));
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.setState("reconnecting");
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private handleBrowserOnline = (): void => {
    // Connectivity is back: skip the remaining backoff.
    if (this.ws || this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.open();
  };

  private giveUp(reason: string): void {
    this.stopped = true;
    this.closedReason = reason;
    this.clearTimers();
    this.setState("closed");
  }

  private startMessage(): DeviceClientMessage {
    return this.mode === "audio"
      ? { type: "start", mode: "audio", sample_rate: this.opts.sampleRate, encoding: "pcm16", device_id: this.opts.deviceId }
      : { type: "start", mode: "text", device_id: this.opts.deviceId };
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private rawSend(data: DeviceClientMessage | ArrayBuffer): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(data instanceof ArrayBuffer ? data : JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.retryTimer = this.pingTimer = this.readyTimer = null;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.opts.onConnection({
      state: this.state,
      queued: this.outbox.size,
      bufferedAudioMs: Math.round(this.outbox.bufferedAudioMs),
      attempt: this.attempt,
      closedReason: this.closedReason,
    });
  }
}
