import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorMessage } from "@/api/client";
import type { CaptureMode, Draft, EventEnvelope, Gap, Session, TranscriptSegment, VoicePrompt } from "@/api/types";
import type { AudioCapture } from "@/audio/AudioCapture";
import { createAudioCapture } from "@/audio/createAudioCapture";
import { useAuth } from "@/auth/AuthContext";
import { applyPatchEvent } from "@/form/patch";
import { type ConnectionInfo, DeviceSocket } from "@/realtime/DeviceSocket";
import { createSpeechRecognizer } from "@/speech/createSpeechRecognizer";
import type { SpeechRecognizer } from "@/speech/SpeechRecognizer";
import { playPrompt } from "@/voice/playPrompt";
import { deviceId } from "./deviceId";

const TRANSCRIPT_TAIL = 8;
const LEVEL_UPDATE_MS = 150;

/** How speech gets to the gateway right now, shown to the crew. */
export type InputMethod = "audio" | "speech" | "typing";

export interface LiveState {
  session: Session | null;
  draft: Draft | null;
  gaps: Gap[];
  transcript: TranscriptSegment[];
  prompts: VoicePrompt[];
  connection: ConnectionInfo;
  mode: CaptureMode;
  inputMethod: InputMethod;
  notice: string | null;
  error: string | null;
  paused: boolean;
  interim: string;
  level: number;
  speaking: boolean;
  ending: boolean;
}

const initialConnection: ConnectionInfo = { state: "connecting", queued: 0, bufferedAudioMs: 0, attempt: 0 };

/**
 * Controller for the live briefing screen: owns the device socket, audio capture or on-device
 * speech recognition, the local copy of the draft (kept current from `form.patched` events),
 * gaps, transcript tail and spoken prompts.
 */
export function useLiveBriefing(sessionId: string, speaker: string) {
  const { token } = useAuth();
  // Latest values for long-lived callbacks (socket, recogniser) without re-creating them.
  const tokenRef = useRef(token);
  const speakerRef = useRef(speaker);
  useEffect(() => {
    tokenRef.current = token;
    speakerRef.current = speaker;
  }, [token, speaker]);
  const [capture] = useState<AudioCapture>(createAudioCapture);

  const [state, setState] = useState<LiveState>({
    session: null,
    draft: null,
    gaps: [],
    transcript: [],
    prompts: [],
    connection: initialConnection,
    mode: capture.supported ? "audio" : "text",
    inputMethod: "typing",
    notice: null,
    error: null,
    paused: false,
    interim: "",
    level: 0,
    speaking: false,
    ending: false,
  });
  const patch = useCallback((p: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);

  const socketRef = useRef<DeviceSocket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const pausedRef = useRef(false);
  const startedAt = useRef(0);
  const utteranceStart = useRef<number | null>(null);
  const promptPlaying = useRef(false);

  const elapsedMs = () => Date.now() - startedAt.current;

  // --- server state sync ---------------------------------------------------------------------

  const setDraft = useCallback(
    (draft: Draft) => {
      draftRef.current = draft;
      patch({ draft });
    },
    [patch],
  );

  const resync = useCallback(async () => {
    try {
      const [detail, transcript] = await Promise.all([api.session(sessionId), api.transcript(sessionId)]);
      setDraft(detail.draft);
      patch({ session: detail.session, gaps: detail.gaps, transcript: transcript.slice(-TRANSCRIPT_TAIL) });
    } catch (err) {
      patch({ error: errorMessage(err) });
    }
  }, [sessionId, patch, setDraft]);

  // --- text mode: on-device recognition --------------------------------------------------------

  const sendTranscript = useCallback((text: string, confidence: number, startMs: number, endMs: number) => {
    const clean = text.trim();
    if (!clean) return;
    socketRef.current?.send({
      type: "transcript",
      text: clean,
      speaker_user_id: speakerRef.current,
      confidence: Math.max(0, Math.min(1, confidence)),
      start_ms: Math.max(0, Math.round(startMs)),
      end_ms: Math.max(0, Math.round(endMs)),
    });
  }, []);

  const startRecognizer = useCallback(async () => {
    const rec = recognizerRef.current ?? createSpeechRecognizer();
    recognizerRef.current = rec;
    if (!rec.available) {
      patch({ inputMethod: "typing" });
      return;
    }
    try {
      await rec.start({
        onResult: (r) => {
          if (promptPlaying.current) return;
          utteranceStart.current ??= elapsedMs();
          if (!r.isFinal) {
            patch({ interim: r.text });
            return;
          }
          sendTranscript(r.text, r.confidence, utteranceStart.current, elapsedMs());
          utteranceStart.current = null;
          patch({ interim: "" });
        },
        onError: (message) => patch({ notice: `${message} You can type instead.` }),
      });
      patch({ inputMethod: "speech" });
    } catch (err) {
      patch({ inputMethod: "typing", notice: `${errorMessage(err)} You can type instead.` });
    }
  }, [patch, sendTranscript]);

  const switchToText = useCallback(
    async (reason: string) => {
      if (socketRef.current?.currentMode === "text" && recognizerRef.current) return;
      await captureRef.current?.stop();
      captureRef.current = null;
      socketRef.current?.setMode("text");
      patch({ mode: "text", notice: reason, level: 0, speaking: false });
      if (!pausedRef.current) await startRecognizer();
    },
    [patch, startRecognizer],
  );

  // --- events ----------------------------------------------------------------------------------

  const handleEvent = useCallback(
    (ev: EventEnvelope) => {
      switch (ev.type) {
        case "form.patched": {
          const current = draftRef.current;
          if (!current) return;
          const outcome = applyPatchEvent(current, ev.payload.revision, ev.payload.patches);
          if (outcome.kind === "applied") setDraft(outcome.draft);
          else if (outcome.kind === "resync") void api.draft(sessionId).then(setDraft).catch(() => undefined);
          return;
        }
        case "form.snapshot":
          setDraft(ev.payload);
          return;
        case "gaps.updated":
          patch({ gaps: ev.payload.gaps });
          return;
        case "transcript.segment":
          patch((s) => ({
            transcript: [...s.transcript.filter((t) => t.id !== ev.payload.id), ev.payload].slice(-TRANSCRIPT_TAIL),
          }));
          return;
        case "session.updated":
          patch({ session: ev.payload });
          return;
        case "session.state_changed":
          patch((s) => ({ session: s.session ? { ...s.session, state: ev.payload.to } : s.session }));
          return;
        case "recording.changed":
          patch((s) => ({ session: s.session ? { ...s.session, recording: ev.payload.recording } : s.session }));
          return;
        case "presence.updated": {
          const current = draftRef.current;
          if (!current) return;
          const crew = Object.fromEntries(ev.payload.crew.map((c) => [c.user_id, c]));
          setDraft({ ...current, form: { ...current.form, crew } });
          return;
        }
        case "voice.prompt": {
          const prompt = ev.payload;
          patch((s) => ({ prompts: [prompt, ...s.prompts.filter((p) => p.gap_id !== prompt.gap_id)] }));
          promptPlaying.current = true;
          void playPrompt(prompt).finally(() => {
            promptPlaying.current = false;
          });
          return;
        }
        case "error":
          if (ev.payload.code === "stt_unavailable_local") {
            void switchToText(
              "Cloud speech isn't available on this server, so this device is transcribing instead. Pick who is speaking, or type.",
            );
          } else {
            patch({ error: ev.payload.message || ev.payload.code });
          }
          return;
      }
    },
    [patch, sessionId, setDraft, switchToText],
  );
  const handleEventRef = useRef(handleEvent);
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  // --- lifecycle -------------------------------------------------------------------------------

  useEffect(() => {
    let disposed = false;
    startedAt.current = Date.now();
    captureRef.current = capture;
    const initialMode: CaptureMode = capture.supported ? "audio" : "text";
    const socket = new DeviceSocket({
      sessionId,
      deviceId: deviceId(),
      sampleRate: capture.sampleRate,
      getToken: () => tokenRef.current,
      onEvent: (ev) => handleEventRef.current(ev),
      onConnection: (connection) => {
        if (!disposed) patch({ connection });
      },
      onReconnected: () => void resync(),
    });
    socketRef.current = socket;

    (async () => {
      await resync();
      await socket.connect(initialMode);
      if (disposed) return;
      if (!capture.supported) {
        await switchToText(capture.unsupportedReason ?? "Using on-device speech recognition.");
        return;
      }
      let lastLevel = 0;
      try {
        await capture.start({
          onFrame: (pcm) => socket.sendAudio(pcm),
          onLevel: (level, speaking) => {
            const now = Date.now();
            if (now - lastLevel < LEVEL_UPDATE_MS) return;
            lastLevel = now;
            patch({ level, speaking });
          },
        });
        if (disposed) await capture.stop();
        else patch({ inputMethod: "audio" });
      } catch (err) {
        if (!disposed) await switchToText(`Microphone unavailable (${errorMessage(err)}). Using text mode.`);
      }
    })();

    return () => {
      disposed = true;
      socket.close();
      void captureRef.current?.stop();
      recognizerRef.current?.stop();
      socketRef.current = null;
    };
  }, [sessionId, capture, patch, resync, switchToText]);

  // --- actions ---------------------------------------------------------------------------------

  const togglePause = useCallback(async () => {
    const paused = !pausedRef.current;
    pausedRef.current = paused;
    socketRef.current?.setPaused(paused);
    if (paused) {
      captureRef.current?.pause();
      recognizerRef.current?.stop();
      patch({ paused, interim: "", level: 0, speaking: false });
    } else {
      captureRef.current?.resume();
      patch({ paused });
      if (socketRef.current?.currentMode === "text") await startRecognizer();
    }
  }, [patch, startRecognizer]);

  const sendTyped = useCallback(
    (text: string) => {
      const now = elapsedMs();
      sendTranscript(text, 1, now, now);
    },
    [sendTranscript],
  );

  const dismissPrompt = useCallback((gapId: string) => {
    patch((s) => ({ prompts: s.prompts.filter((p) => p.gap_id !== gapId) }));
  }, [patch]);

  /** End via REST (authoritative); when offline, queue the WS `end` so it goes out on reconnect. */
  const endBriefing = useCallback(async (): Promise<boolean> => {
    patch({ ending: true, error: null });
    await captureRef.current?.stop();
    recognizerRef.current?.stop();
    try {
      const session = await api.endBriefing(sessionId);
      patch({ session, ending: false });
      return true;
    } catch (err) {
      const message = errorMessage(err);
      socketRef.current?.send({ type: "end" });
      patch({ ending: false, error: `${message} The end of briefing will be sent when the connection is back.` });
      return false;
    }
  }, [patch, sessionId]);

  return { state, togglePause, sendTyped, dismissPrompt, endBriefing, refresh: resync };
}
