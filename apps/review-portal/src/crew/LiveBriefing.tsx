import { useQueryClient } from "@tanstack/react-query";
import { Check, Keyboard, Minus, Pause, Play, RotateCcw, Send, Square, Upload, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { qk, useUserDirectory } from "../api/queries";
import type { Clarification, Session, SessionDetail, TranscriptSegment } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toasts";
import { guestLabel } from "../format";
import type { ReceivedActivity, ReceivedPrompt } from "../realtime/useSessionLive";
import { AgentStrip } from "./AgentStrip";
import { CrewForm, TranscriptTail } from "./CrewForm";
import { AudioCapture, audioUnsupportedReason } from "./device/audioCapture";
import { DeviceSocket, type ConnectionState, type DeviceError } from "./device/deviceSocket";
import { playPrompt, stopPrompt } from "./device/playPrompt";
import { SpeechRecognizer, speechRecognitionAvailable } from "./device/speechRecognizer";
import { rememberScenario, scenarioById, SCENARIOS, storedScenario, type ScenarioLine } from "./scenarios";
import { useScriptPlayer } from "./useScriptPlayer";

type Mic = "off" | "starting" | "audio" | "speech";

const SPEEDS = [1, 2, 4] as const;
const NO_LINES: ScenarioLine[] = [];
/** Let the gateway flush buffered lines (pause flushes) before asking for the final pass. */
const END_FLUSH_MS = 700;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function deviceId(): string {
  try {
    const existing = localStorage.getItem("crewbrief.deviceId");
    if (existing) return existing;
    const id = `web-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("crewbrief.deviceId", id);
    return id;
  } catch {
    return "web-device";
  }
}

interface Props {
  detail: SessionDetail;
  segments: TranscriptSegment[];
  prompts: ReceivedPrompt[];
  agents: ReceivedActivity[];
}

/**
 * The crew device while the briefing is live: steps 1 (Record) and 2 (Clarify). One device
 * connection serves both, so answers to the closing questions stream like the briefing did.
 */
export function LiveBriefing({ detail, segments, prompts, agents }: Props) {
  const device = useCrewDevice(detail.session.id);
  const clarifications = detail.session.clarifications ?? [];
  if (detail.session.state === "GAP_CHECK" && clarifications.length > 0) {
    return <ClarifyView session={detail.session} clarifications={clarifications} device={device} prompts={prompts} />;
  }
  return <RecordView detail={detail} segments={segments} device={device} agents={agents} />;
}

// --- device ------------------------------------------------------------------------------------

interface CrewDevice {
  conn: ConnectionState;
  closedReason: string | undefined;
  mic: Mic;
  listening: boolean;
  interim: string;
  /** Neither server transcription nor on-device recognition works here: typing is the way in. */
  typingOnly: boolean;
  levelRef: RefObject<HTMLSpanElement>;
  socket: RefObject<DeviceSocket | null>;
  startMic: () => Promise<void>;
  stopMic: () => Promise<void>;
  sendLine: (text: string, confidence?: number) => void;
  setPaused: (paused: boolean) => void;
  /** Stop listening while CrewBrief speaks, so it doesn't transcribe itself. */
  mute: () => void;
  unmute: () => void;
}

/**
 * Audio first: microphone audio goes to the gateway for Azure transcription with speaker
 * separation. When the gateway can't transcribe (`stt_unavailable_local`), fall back to the
 * browser's speech recognition, and when that's missing too, to typing.
 */
function useCrewDevice(sessionId: string): CrewDevice {
  const { user, getToken } = useAuth();
  const toast = useToast();
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [closedReason, setClosedReason] = useState<string | undefined>();
  const [mic, setMic] = useState<Mic>("off");
  const [interim, setInterim] = useState("");
  const [typingOnly, setTypingOnly] = useState(false);

  const sockRef = useRef<DeviceSocket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const recRef = useRef<SpeechRecognizer | null>(null);
  const levelRef = useRef<HTMLSpanElement>(null);
  const sttFallback = useRef(false);
  const micRef = useRef<Mic>("off");
  micRef.current = mic;
  const t0 = useRef(Date.now());
  const userRef = useRef(user);
  userRef.current = user;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const sendLine = (text: string, confidence = 0.95) => {
    const now = Date.now() - t0.current;
    sockRef.current?.sendTranscript({
      text,
      speaker_user_id: userRef.current?.id,
      confidence,
      start_ms: now,
      end_ms: now + Math.max(1000, text.length * 55),
    });
  };

  const stopCapture = async () => {
    const cap = captureRef.current;
    captureRef.current = null;
    await cap?.stop();
    if (levelRef.current) levelRef.current.style.transform = "scaleX(0)";
  };

  const restartSpeech = () => {
    const rec = new SpeechRecognizer();
    recRef.current = rec;
    rec.start({
      onResult: (r) => {
        if (!r.isFinal) return setInterim(r.text);
        setInterim("");
        if (r.text) sendLine(r.text, r.confidence);
      },
      onError: (m) => toastRef.current.push("warning", m),
    });
  };

  const startSpeech = () => {
    if (!speechRecognitionAvailable()) {
      setMic("off");
      setTypingOnly(true);
      toastRef.current.push("info", "Type what's said instead", "This browser can't turn speech into text here.");
      return;
    }
    try {
      restartSpeech();
      setMic("speech");
    } catch (err) {
      setMic("off");
      setTypingOnly(true);
      toastRef.current.error(err, "Could not start listening");
    }
  };

  const onDeviceError = useRef<(e: DeviceError) => void>(() => undefined);
  onDeviceError.current = (e) => {
    if (e.code === "stt_unavailable_local" || e.code === "stt_failed") {
      sttFallback.current = true;
      if (micRef.current === "audio" || micRef.current === "starting") {
        void stopCapture().then(() => {
          sockRef.current?.setMode("text");
          startSpeech();
        });
      }
      return;
    }
    toastRef.current.push("warning", "Connection problem", e.message ?? e.code);
  };

  useEffect(() => {
    const sock = new DeviceSocket({
      sessionId,
      deviceId: deviceId(),
      getToken: () => getTokenRef.current(),
      onError: (e) => onDeviceError.current(e),
      onConnection: (state, reason) => {
        setConn(state);
        setClosedReason(reason);
      },
    });
    sockRef.current = sock;
    sock.connect("text");
    return () => {
      sock.close();
      sockRef.current = null;
    };
  }, [sessionId]);

  // Release the microphone and silence speech when leaving the screen.
  useEffect(
    () => () => {
      recRef.current?.stop();
      void captureRef.current?.stop();
      stopPrompt();
    },
    [],
  );

  const startMic = async () => {
    if (!sockRef.current || micRef.current !== "off") return;
    if (!sttFallback.current && !audioUnsupportedReason()) {
      setMic("starting");
      micRef.current = "starting";
      try {
        sockRef.current.setMode("audio");
        const cap = new AudioCapture();
        captureRef.current = cap;
        await cap.start({
          onFrame: (f) => sockRef.current?.sendAudio(f),
          onLevel: (level) => {
            if (levelRef.current) levelRef.current.style.transform = `scaleX(${level.toFixed(2)})`;
          },
        });
        // Stopped while starting (a short press), or the gateway already said it can't transcribe.
        if (captureRef.current === cap) setMic("audio");
        else if ((micRef.current as Mic) !== "speech") await cap.stop();
        return;
      } catch (err) {
        await stopCapture();
        sockRef.current?.setMode("text");
        toastRef.current.push("warning", "Microphone unavailable", err instanceof Error ? err.message : undefined);
        setMic("off");
        return;
      }
    }
    startSpeech();
  };

  const stopMic = async () => {
    recRef.current?.stop();
    recRef.current = null;
    await stopCapture();
    setInterim("");
    setMic("off");
    micRef.current = "off";
    if (sockRef.current?.currentMode === "audio") sockRef.current.setMode("text");
  };

  return {
    conn,
    closedReason,
    mic,
    listening: mic === "audio" || mic === "speech",
    interim,
    typingOnly,
    levelRef,
    socket: sockRef,
    startMic,
    stopMic,
    sendLine,
    setPaused: (p) => sockRef.current?.setPaused(p),
    mute: () => {
      if (micRef.current === "speech") recRef.current?.stop();
      captureRef.current?.pause();
    },
    unmute: () => {
      captureRef.current?.resume();
      if (micRef.current === "speech") restartSpeech();
    },
  };
}

// --- step 1: record ----------------------------------------------------------------------------

function RecordView({ detail, segments, device, agents }: { detail: SessionDetail; segments: TranscriptSegment[]; device: CrewDevice; agents: ReceivedActivity[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const users = useUserDirectory();
  const session = detail.session;
  const [paused, setPaused] = useState(false);
  const [ending, setEnding] = useState(false);
  const [typing, setTyping] = useState(false);
  const [line, setLine] = useState("");
  const holdRef = useRef(false);
  holdRef.current = paused || ending;

  // Demo script, tucked away in the "Demo" panel.
  const [scenarioId, setScenarioId] = useState(() => storedScenario(session.id) ?? "");
  const [speed, setSpeed] = useState<number>(1);
  const scenario = scenarioById(scenarioId);
  const lines = scenario?.lines ?? NO_LINES;
  const player = useScriptPlayer(
    lines,
    speed,
    (l) =>
      device.socket.current?.sendTranscript({
        text: l.text,
        speaker_user_id: l.speaker,
        confidence: 0.95,
        start_ms: l.at_ms,
        end_ms: l.at_ms + Math.max(1500, l.text.length * 55),
      }),
    holdRef,
  );

  const voices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of segments) {
      if (s.source === "voice_prompt") continue;
      seen.set(s.speaker_id, s.speaker_name ?? (s.user_id ? users.get(s.user_id)?.name : undefined) ?? guestLabel(s.speaker_id));
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [segments, users]);
  const lastVoice = [...segments].reverse().find((s) => s.source !== "voice_prompt")?.speaker_id;

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    device.setPaused(next);
    if (next) {
      void device.stopMic();
      player.pause();
    }
  };

  const submitLine = (e: FormEvent) => {
    e.preventDefault();
    const text = line.trim();
    if (!text || paused) return;
    device.sendLine(text);
    setLine("");
  };

  const endBriefing = async () => {
    setEnding(true);
    player.pause();
    await device.stopMic();
    device.setPaused(true);
    await new Promise((r) => window.setTimeout(r, END_FLUSH_MS));
    try {
      const s = await api.endBriefing(session.id);
      qc.setQueryData<SessionDetail>(qk.session(session.id), (d) => (d ? { ...d, session: s } : d));
      void qc.invalidateQueries({ queryKey: qk.session(session.id) });
      void qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (err) {
      toast.error(err, "Could not end the briefing");
      device.setPaused(paused);
      setEnding(false);
    }
  };

  const recording = session.recording === "active" && !paused;
  const showTyping = typing || device.typingOnly;

  return (
    <div className="record-layout">
      {ending && (
        <div className="finalising" role="status">
          <span className="spinner spinner-lg" aria-hidden="true" />
          <h2>Checking the form</h2>
          <p className="muted">Looking for anything critical that wasn't covered.</p>
          <AgentStrip activity={agents} idle="Starting the final pass…" />
        </div>
      )}

      <div className="record-main">
        <section className="card crew-card record-card" aria-label="Recording">
          <div className="record-status">
            <span className={`rec ${recording ? "rec-active" : "rec-paused"}`}>
              {recording ? (
                <>
                  <span className="rec-dot" aria-hidden="true" /> Recording
                </>
              ) : paused ? (
                <>
                  <Pause size={16} aria-hidden="true" /> Paused. Nothing is being captured
                </>
              ) : (
                "Connecting…"
              )}
            </span>
            {device.conn !== "online" && (
              <span className={`conn conn-${device.conn}`} title={device.closedReason}>
                {device.conn === "closed" ? "Disconnected" : "Connecting…"}
              </span>
            )}
          </div>

          <button
            type="button"
            className={`record-btn${device.listening ? " is-on" : ""}`}
            aria-pressed={device.listening}
            disabled={paused || ending || device.mic === "starting" || device.typingOnly}
            onClick={() => void (device.mic === "off" ? device.startMic() : device.stopMic())}
          >
            <span className="record-btn-dot" aria-hidden="true" />
            <span className="sr-only">{device.listening ? "Stop the microphone" : "Start the microphone"}</span>
          </button>
          <p className="record-hint" aria-live="polite">
            {device.typingOnly
              ? "This device can't listen here. Type what's said below."
              : device.mic === "starting"
                ? "Starting the microphone…"
                : device.listening
                  ? "Listening. Talk through the job as normal."
                  : "Tap to listen. Put the device where everyone can be heard."}
          </p>
          <span className="level" aria-hidden="true">
            <span ref={device.levelRef} />
          </span>
          {device.interim && <p className="interim">“{device.interim}”</p>}

          {voices.length > 0 && (
            <div className="voices" aria-label="Voices heard">
              {voices.map((v) => (
                <span key={v.id} className={`voice-chip${v.id === lastVoice ? " is-last" : ""}`}>
                  <span className="avatar" aria-hidden="true">
                    {v.name.charAt(0)}
                  </span>
                  {v.name}
                </span>
              ))}
            </div>
          )}

          {showTyping && (
            <form className="type-line" onSubmit={submitLine}>
              <label className="sr-only" htmlFor="type-line">
                Type what was said
              </label>
              <input
                id="type-line"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                placeholder="Type what was said…"
                disabled={paused || ending}
                maxLength={2000}
              />
              <button type="submit" className="btn btn-secondary btn-large" disabled={!line.trim() || paused || ending}>
                <Send size={20} aria-hidden="true" />
                Send
              </button>
            </form>
          )}

          <div className="record-actions">
            <button type="button" className="btn btn-secondary btn-xl" onClick={togglePause} disabled={ending}>
              {paused ? <Play size={20} aria-hidden="true" /> : <Pause size={20} aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="btn btn-xl btn-primary" onClick={() => void endBriefing()} disabled={ending}>
              <Square size={18} aria-hidden="true" fill="currentColor" />
              End briefing
            </button>
          </div>

          <div className="record-alt">
            {!device.typingOnly && (
              <button type="button" className="btn btn-ghost" aria-expanded={typing} onClick={() => setTyping((t) => !t)}>
                <Keyboard size={16} aria-hidden="true" />
                {typing ? "Hide typing" : "Type instead"}
              </button>
            )}
            <UploadRecording sessionId={session.id} disabled={ending} />
          </div>
        </section>

        <details className="card crew-card demo-panel">
          <summary>Demo script</summary>
          <label className="field">
            <span className="sr-only">Scripted briefing</span>
            <select
              value={scenarioId}
              onChange={(e) => {
                setScenarioId(e.target.value);
                rememberScenario(session.id, e.target.value || null);
              }}
              disabled={player.status === "playing"}
            >
              <option value="">Choose a scenario</option>
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <div className="demo-controls">
            <div className="segmented" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
            {player.status === "playing" ? (
              <button type="button" className="btn btn-secondary" onClick={player.pause}>
                <Pause size={16} aria-hidden="true" />
                Pause script
              </button>
            ) : player.status === "done" ? (
              <button type="button" className="btn btn-secondary" onClick={player.restart}>
                <RotateCcw size={16} aria-hidden="true" />
                Restart
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={player.play} disabled={!lines.length || paused || ending || device.conn === "closed"}>
                <Play size={16} aria-hidden="true" />
                {player.status === "paused" ? "Resume script" : "Play script"}
              </button>
            )}
            {lines.length > 0 && (
              <span className="muted small tnum">
                {player.next} of {lines.length} lines
              </span>
            )}
          </div>
        </details>

        <section className="card crew-card" aria-labelledby="tail-title">
          <h2 id="tail-title">What CrewBrief heard</h2>
          <TranscriptTail segments={segments} />
        </section>
      </div>

      <aside className="card crew-card record-side" aria-labelledby="form-title">
        <h2 id="form-title">Form so far</h2>
        <CrewForm form={detail.draft.form} live />
      </aside>
    </div>
  );
}

function UploadRecording({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ kind: "busy" | "note" | "error"; text: string } | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setState({ kind: "error", text: "That file is over 100 MB. Trim the recording and try again." });
      return;
    }
    setState({ kind: "busy", text: `Transcribing ${file.name}…` });
    try {
      const r = await api.uploadRecording(sessionId, file);
      setState(null);
      toast.push("success", `Transcribed ${r.segments} line${r.segments === 1 ? "" : "s"}`);
      void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      void qc.invalidateQueries({ queryKey: qk.transcript(sessionId) });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 501 || err.code === "stt_unavailable_local")) {
        setState({
          kind: "note",
          text: "Uploading a recording needs Azure AI Speech, which isn't connected in this local setup. Record live or play the demo script instead.",
        });
      } else {
        setState({ kind: "error", text: err instanceof Error ? err.message : "The upload failed." });
      }
    }
  };

  return (
    <>
      <button type="button" className="btn btn-ghost" disabled={disabled || state?.kind === "busy"} onClick={() => input.current?.click()}>
        <Upload size={16} aria-hidden="true" />
        Upload a recording
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,audio/webm,.wav,.mp3,.m4a,.ogg,.webm"
        className="sr-only"
        tabIndex={-1}
        aria-label="Recording file"
        onChange={(e) => void onFile(e)}
      />
      {state && (
        <p className={`upload-note upload-${state.kind}`} role={state.kind === "error" ? "alert" : "status"}>
          {state.kind === "busy" && <span className="spinner" aria-hidden="true" />} {state.text}
        </p>
      )}
    </>
  );
}

// --- step 2: clarify ---------------------------------------------------------------------------

function ClarifyView({
  session,
  clarifications,
  device,
  prompts,
}: {
  session: Session;
  clarifications: Clarification[];
  device: CrewDevice;
  prompts: ReceivedPrompt[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const spoken = useRef(new Set<string>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const promptsRef = useRef(prompts);
  promptsRef.current = prompts;
  const deviceRef = useRef(device);
  deviceRef.current = device;

  const open = clarifications.filter((c) => c.status === "open");
  const activeId = speakingId ?? open[0]?.gap_id ?? null;
  const openKey = open.map((c) => c.gap_id).join("|");

  // The device was paused when the briefing ended: resume so answers are heard.
  useEffect(() => {
    deviceRef.current.setPaused(false);
  }, []);

  const say = (c: Clarification) => {
    chain.current = chain.current.then(async () => {
      setSpeakingId(c.gap_id);
      deviceRef.current.mute();
      // Azure mode sends synthesised audio with the voice.prompt event; otherwise the browser speaks.
      const prompt = promptsRef.current.find((p) => p.gap_id === c.gap_id);
      try {
        await playPrompt(prompt ?? { gap_id: c.gap_id, text: c.question, priority: 0, audio_b64: null, audio_format: null });
      } finally {
        deviceRef.current.unmute();
        setSpeakingId(null);
      }
    });
  };

  // Each question is spoken once, in order.
  useEffect(() => {
    for (const c of open) {
      if (spoken.current.has(c.gap_id)) continue;
      spoken.current.add(c.gap_id);
      say(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  const sendAnswer = (e: FormEvent) => {
    e.preventDefault();
    const text = answer.trim();
    if (!text) return;
    device.sendLine(text);
    setAnswer("");
    setSent(true);
  };

  const finish = async () => {
    setFinishing(true);
    stopPrompt();
    await device.stopMic();
    try {
      const s = await api.finishClarifications(session.id);
      qc.setQueryData<SessionDetail>(qk.session(session.id), (d) => (d ? { ...d, session: s } : d));
      void qc.invalidateQueries({ queryKey: qk.session(session.id) });
    } catch (err) {
      toast.error(err, "Could not finish");
      setFinishing(false);
    }
  };

  const holdStart = () => {
    if (!speakingId) void device.startMic();
  };
  const holdEnd = () => {
    if (device.mic !== "off") void device.stopMic();
  };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    holdStart();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      holdStart();
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      holdEnd();
    }
  };

  return (
    <section className="card crew-card clarify" aria-labelledby="clarify-title">
      <header className="clarify-head">
        <h2 id="clarify-title">A few things to check before work starts</h2>
        <p className="muted">Answer out loud or type. Answers go straight into the form.</p>
      </header>

      <ol className="clar-list">
        {clarifications.map((c, i) => {
          const active = c.gap_id === activeId && c.status === "open";
          return (
            <li key={c.gap_id} className={`clar clar-${c.status}${active ? " clar-active" : ""}`} aria-current={active ? "step" : undefined}>
              <span className="clar-mark" aria-hidden="true">
                {c.status === "answered" ? <Check size={16} strokeWidth={3} /> : c.status === "skipped" ? <Minus size={16} /> : i + 1}
              </span>
              <span className="clar-q">{c.question}</span>
              <span className="clar-status">
                {c.status === "answered"
                  ? "Answered"
                  : c.status === "skipped"
                    ? "Left for review"
                    : speakingId === c.gap_id
                      ? "Asking…"
                      : active
                        ? "Waiting for an answer"
                        : "Up next"}
              </span>
              {active && speakingId !== c.gap_id && (
                <button type="button" className="btn btn-ghost btn-small clar-repeat" onClick={() => say(c)} disabled={!!speakingId}>
                  <Volume2 size={16} aria-hidden="true" />
                  Repeat
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {open.length > 0 && (
        <div className="answer-box">
          {!device.typingOnly && (
            <>
              <button
                type="button"
                className={`record-btn hold-btn${device.listening ? " is-on" : ""}`}
                aria-pressed={device.listening}
                aria-describedby="hold-hint"
                disabled={!!speakingId || finishing}
                onPointerDown={onPointerDown}
                onPointerUp={holdEnd}
                onPointerCancel={holdEnd}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onContextMenu={(e) => e.preventDefault()}
              >
                <span className="record-btn-dot" aria-hidden="true" />
                <span className="sr-only">Hold to answer</span>
              </button>
              <p id="hold-hint" className="record-hint" aria-live="polite">
                {speakingId ? "Listen to the question…" : device.listening ? "Listening. Let go when you're done." : "Hold to answer"}
              </p>
              {device.interim && <p className="interim">“{device.interim}”</p>}
            </>
          )}
          <form className="type-line" onSubmit={sendAnswer}>
            <label className="sr-only" htmlFor="answer">
              Type your answer
            </label>
            <input id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Or type your answer…" maxLength={2000} disabled={finishing} />
            <button type="submit" className="btn btn-secondary btn-large" disabled={!answer.trim() || finishing}>
              <Send size={20} aria-hidden="true" />
              Send
            </button>
          </form>
          {sent && <p className="muted small" role="status">Got it. Checking your answer…</p>}
        </div>
      )}

      <div className="clarify-foot">
        {open.length > 0 && <p className="muted small">Anything you don't answer is left for the review step.</p>}
        <button type="button" className="btn btn-primary btn-xl btn-block" onClick={() => void finish()} disabled={finishing}>
          {finishing ? "Finishing…" : "Done"}
        </button>
      </div>
    </section>
  );
}
