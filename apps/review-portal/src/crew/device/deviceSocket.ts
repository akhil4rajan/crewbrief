import { config, toWsUrl } from "../../config";
import { TARGET_SAMPLE_RATE } from "./audioCapture";

export type CaptureMode = "audio" | "text";
export type ConnectionState = "connecting" | "online" | "reconnecting" | "closed";

export interface TranscriptMessage {
  type: "transcript";
  text: string;
  speaker_user_id: string;
  confidence: number;
  start_ms: number;
  end_ms: number;
}

type ClientMessage =
  | { type: "start"; mode: CaptureMode; sample_rate?: number; encoding?: "pcm16"; device_id: string }
  | TranscriptMessage
  | { type: "pause" }
  | { type: "resume" }
  | { type: "end" }
  | { type: "ping" };

export interface DeviceError {
  code: string;
  message?: string;
}

export interface DeviceSocketOptions {
  sessionId: string;
  deviceId: string;
  getToken: () => Promise<string | null>;
  onError: (err: DeviceError) => void;
  onConnection: (state: ConnectionState, closedReason?: string) => void;
}

const PING_INTERVAL_MS = 15_000;
const READY_FALLBACK_MS = 2_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** Ten seconds of 20 ms audio frames; older audio is dropped rather than replayed late. */
const MAX_QUEUED_AUDIO = 500;
const MAX_QUEUED_TEXT = 200;
/** Close codes after which retrying cannot help (policy/auth, or the gateway's 44xx app codes). */
const FATAL_CLOSE = (code: number) => code === 1008 || (code >= 4400 && code < 4500);

/**
 * The crew device's link to the gateway (`/ws/device/{id}`, docs/api/contracts.md). Owns
 * reconnection with backoff + jitter, the `start` handshake on every (re)connect, and an
 * in-memory queue so lines sent while disconnected are delivered in order once `ready`.
 * Events also arrive here, but the page reads them from the shared live socket instead.
 */
export class DeviceSocket {
  private ws: WebSocket | null = null;
  private mode: CaptureMode = "text";
  private paused = false;
  private ready = false;
  private attempt = 0;
  private stopped = false;
  private queue: (ClientMessage | ArrayBuffer)[] = [];
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private readyTimer: number | undefined;

  constructor(private readonly opts: DeviceSocketOptions) {}

  connect(mode: CaptureMode): void {
    this.mode = mode;
    void this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "client closing");
    this.ws = null;
    this.opts.onConnection("closed");
  }

  get currentMode(): CaptureMode {
    return this.mode;
  }

  /** Switch capture mode, e.g. to `text` when the gateway cannot transcribe audio. */
  setMode(mode: CaptureMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "text") this.queue = this.queue.filter((m) => !(m instanceof ArrayBuffer));
    if (this.isOpen()) {
      // The gateway treats every `start` as active recording; restate a pause.
      this.rawSend(this.startMessage());
      if (this.paused) this.rawSend({ type: "pause" });
    }
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.send(paused ? { type: "pause" } : { type: "resume" });
  }

  sendTranscript(msg: Omit<TranscriptMessage, "type">): void {
    this.send({ type: "transcript", ...msg });
  }

  sendAudio(frame: ArrayBuffer): void {
    if (this.mode !== "audio") return;
    if (this.ready && this.queue.length === 0 && this.rawSend(frame)) return;
    this.queue.push(frame);
    this.trim();
  }

  private send(msg: ClientMessage): void {
    if (this.ready && this.queue.length === 0 && this.rawSend(msg)) return;
    this.queue.push(msg);
    this.trim();
  }

  private trim(): void {
    let audio = 0;
    let text = 0;
    for (const m of this.queue) {
      if (m instanceof ArrayBuffer) audio++;
      else text++;
    }
    if (audio > MAX_QUEUED_AUDIO) {
      const idx = this.queue.findIndex((m) => m instanceof ArrayBuffer);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    if (text > MAX_QUEUED_TEXT) {
      const idx = this.queue.findIndex((m) => !(m instanceof ArrayBuffer));
      if (idx >= 0) this.queue.splice(idx, 1);
    }
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.opts.onConnection(this.attempt === 0 ? "connecting" : "reconnecting");
    const token = await this.opts.getToken().catch(() => null);
    if (this.stopped) return;
    if (!token) return this.giveUp("Signed out");
    const url = `${toWsUrl(config.gatewayUrl)}/ws/device/${encodeURIComponent(this.opts.sessionId)}?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.rawSend(this.startMessage());
      if (this.paused) this.rawSend({ type: "pause" });
      // Don't hold the queue hostage if `ready` never arrives.
      this.readyTimer = window.setTimeout(() => this.markReady(), READY_FALLBACK_MS);
      this.pingTimer = window.setInterval(() => this.rawSend({ type: "ping" }), PING_INTERVAL_MS);
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearTimers();
      if (this.stopped) return;
      if (FATAL_CLOSE(ev.code)) return this.giveUp(ev.reason || `Connection refused (${ev.code})`);
      this.attempt += 1;
      const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1));
      this.opts.onConnection("reconnecting");
      this.retryTimer = window.setTimeout(() => void this.open(), ceiling / 2 + Math.random() * (ceiling / 2));
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: { type?: string; code?: string; message?: string; payload?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "ready") return this.markReady();
    if (msg.type !== "error") return;
    // Errors come either as an EventEnvelope (payload) or as a bare frame.
    const code = msg.payload?.code ?? msg.code;
    if (code) this.opts.onError({ code, message: msg.payload?.message ?? msg.message });
  }

  private markReady(): void {
    window.clearTimeout(this.readyTimer);
    if (this.ready || !this.isOpen()) return;
    this.ready = true;
    this.attempt = 0;
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) {
      if (m instanceof ArrayBuffer && this.mode !== "audio") continue;
      if (!this.rawSend(m)) this.queue.push(m);
    }
    this.opts.onConnection("online");
  }

  private giveUp(reason: string): void {
    this.stopped = true;
    this.clearTimers();
    this.opts.onConnection("closed", reason);
  }

  private startMessage(): ClientMessage {
    return this.mode === "audio"
      ? { type: "start", mode: "audio", sample_rate: TARGET_SAMPLE_RATE, encoding: "pcm16", device_id: this.opts.deviceId }
      : { type: "start", mode: "text", device_id: this.opts.deviceId };
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private rawSend(data: ClientMessage | ArrayBuffer): boolean {
    if (!this.ws || !this.isOpen()) return false;
    try {
      this.ws.send(data instanceof ArrayBuffer ? data : JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  private clearTimers(): void {
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.readyTimer);
  }
}
