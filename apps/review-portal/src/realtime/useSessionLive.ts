import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { applyPatches, classifyRevision } from "../api/jsonPointer";
import { qk } from "../api/queries";
import type {
  CrewEntry,
  EventEnvelope,
  FormPatchedPayload,
  Gap,
  RecordingState,
  Session,
  SessionDetail,
  StateChangedPayload,
  TranscriptSegment,
  VoicePrompt,
} from "../api/types";
import { useToast } from "../components/Toasts";
import { STATE_LABEL } from "../format";

export type LiveStatus = "connecting" | "open" | "reconnecting" | "offline";

export interface ReceivedPrompt extends VoicePrompt {
  id: string;
  ts: string;
}

export interface LiveState {
  status: LiveStatus;
  /** Crew presence pushed by the form API (null until the first `presence.updated`). */
  presence: CrewEntry[] | null;
  prompts: ReceivedPrompt[];
  lastEventAt: string | null;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_PROMPTS = 50;

function backoff(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2); // full jitter on the upper half
}

/** Merge a segment into the cached transcript, keeping it ordered by seq and de-duplicated by id. */
export function upsertSegment(list: TranscriptSegment[] | undefined, seg: TranscriptSegment): TranscriptSegment[] {
  const rest = (list ?? []).filter((s) => s.id !== seg.id);
  rest.push(seg);
  return rest.sort((a, b) => a.seq - b.seq || a.received_at.localeCompare(b.received_at));
}

function updateDetail(qc: QueryClient, id: string, fn: (d: SessionDetail) => SessionDetail): boolean {
  const current = qc.getQueryData<SessionDetail>(qk.session(id));
  if (!current) return false;
  qc.setQueryData(qk.session(id), fn(current));
  return true;
}

/**
 * Subscribes the page to a session's live events.
 *
 * Flow: GET {gateway}/negotiate → WebSocket. Each event is applied to the React Query cache so
 * every pane re-renders from one source of truth. If a `form.patched` revision does not follow
 * the cached revision, or the socket drops, we resync with GET /api/sessions/{id}.
 */
export function useSessionLive(sessionId: string): LiveState {
  const qc = useQueryClient();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [presence, setPresence] = useState<CrewEntry[] | null>(null);
  const [prompts, setPrompts] = useState<ReceivedPrompt[]>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let disposed = false;
    setPresence(null);
    setPrompts([]);

    const resync = () => {
      void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      void qc.invalidateQueries({ queryKey: qk.transcript(sessionId) });
    };

    const handle = (env: EventEnvelope) => {
      if (env.session_id && env.session_id !== sessionId) return;
      setLastEventAt(env.ts);
      switch (env.type) {
        case "form.patched": {
          const p = env.payload as unknown as FormPatchedPayload;
          const detail = qc.getQueryData<SessionDetail>(qk.session(sessionId));
          if (!detail) return resync();
          const verdict = classifyRevision(detail.draft, p.revision, p.patches.length);
          if (verdict === "stale") return;
          if (verdict === "gap") return resync();
          try {
            const form = applyPatches(detail.draft.form, p.patches);
            qc.setQueryData<SessionDetail>(qk.session(sessionId), {
              ...detail,
              draft: { ...detail.draft, form, revision: p.revision, updated_at: env.ts },
            });
          } catch {
            resync();
          }
          return;
        }
        case "form.snapshot": {
          const draft = env.payload as unknown as SessionDetail["draft"];
          updateDetail(qc, sessionId, (d) => (draft.revision >= d.draft.revision ? { ...d, draft } : d));
          return;
        }
        case "transcript.segment": {
          const seg = env.payload as unknown as TranscriptSegment;
          qc.setQueryData<TranscriptSegment[]>(qk.transcript(sessionId), (list) => upsertSegment(list, seg));
          updateDetail(qc, sessionId, (d) => ({ ...d, transcript_count: d.transcript_count + 1 }));
          return;
        }
        case "gaps.updated": {
          const gaps = (env.payload as { gaps?: Gap[] }).gaps ?? [];
          updateDetail(qc, sessionId, (d) => ({ ...d, gaps }));
          qc.setQueryData(qk.gaps(sessionId), gaps);
          return;
        }
        case "session.state_changed": {
          const p = env.payload as unknown as StateChangedPayload;
          updateDetail(qc, sessionId, (d) => ({ ...d, session: { ...d.session, state: p.to } }));
          toastRef.current.push("info", `Briefing is now ${STATE_LABEL[p.to] ?? p.to}`, p.reason ?? undefined);
          // The transition may have changed other fields (sign-off, AI snapshot revision...).
          void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
          void qc.invalidateQueries({ queryKey: qk.sessions });
          return;
        }
        case "session.updated": {
          const session = env.payload as unknown as Session;
          updateDetail(qc, sessionId, (d) => ({ ...d, session }));
          return;
        }
        case "recording.changed": {
          const recording = (env.payload as { recording: RecordingState }).recording;
          updateDetail(qc, sessionId, (d) => ({ ...d, session: { ...d.session, recording } }));
          return;
        }
        case "voice.prompt": {
          const prompt = env.payload as unknown as VoicePrompt;
          setPrompts((ps) => [...ps.slice(-(MAX_PROMPTS - 1)), { ...prompt, id: env.id, ts: env.ts }]);
          return;
        }
        case "presence.updated": {
          setPresence((env.payload as { crew?: CrewEntry[] }).crew ?? []);
          return;
        }
        case "error": {
          const p = env.payload as { code?: string; message?: string };
          toastRef.current.push("warning", "Live update error", p.message ?? p.code);
          return;
        }
      }
    };

    const schedule = () => {
      if (disposed) return;
      setStatus(attempt === 0 ? "connecting" : attempt > 4 ? "offline" : "reconnecting");
      timer = window.setTimeout(connect, attempt === 0 ? 0 : backoff(attempt));
      attempt += 1;
    };

    const connect = async () => {
      let url: string;
      try {
        url = (await api.negotiate(sessionId)).url;
      } catch {
        return schedule();
      }
      if (disposed) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        const wasReconnect = attempt > 1;
        attempt = 1; // next drop starts the backoff from the beginning
        setStatus("open");
        // Anything published while we were away is only in the store: resync.
        if (wasReconnect) resync();
      };
      socket.onmessage = (msg) => {
        if (typeof msg.data !== "string") return;
        try {
          handle(JSON.parse(msg.data) as EventEnvelope);
        } catch (err) {
          console.warn("live_event_parse_failed", err);
        }
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        schedule();
      };
    };

    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [sessionId, qc]);

  return { status, presence, prompts, lastEventAt };
}
