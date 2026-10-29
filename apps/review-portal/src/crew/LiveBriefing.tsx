import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { SessionDetail, TranscriptSegment } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toasts";
import type { ReceivedPrompt } from "../realtime/useSessionLive";
import { CrewForm, CrewGaps, TranscriptTail } from "./CrewForm";
import { AudioCapture, audioUnsupportedReason } from "./device/audioCapture";
import { DeviceSocket, type ConnectionState, type DeviceError } from "./device/deviceSocket";
import { playPrompt, stopPrompt } from "./device/playPrompt";
import { SpeechRecognizer, speechRecognitionAvailable } from "./device/speechRecognizer";
import { scenarioById, SCENARIOS, storedScenario, rememberScenario, type ScenarioLine } from "./scenarios";
import { useScriptPlayer } from "./useScriptPlayer";

type Mic = "off" | "starting" | "audio" | "speech";

const SPEEDS = [1, 2, 4] as const;
const NO_LINES: ScenarioLine[] = [];
/** Let the gateway flush buffered lines (pause flushes) before asking for the final pass. */
const END_FLUSH_MS = 700;

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
  nameOf: (id: string | null) => string;
}

/** The crew device during the briefing: capture, demo script, live form and voice prompts. */
export function LiveBriefing({ detail, segments, prompts, nameOf }: Props) {
  const { user, getToken } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const session = detail.session;
  const form = detail.draft.form;

  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [closedReason, setClosedReason] = useState<string | undefined>();
  const [mic, setMic] = useState<Mic>("off");
  const [interim, setInterim] = useState("");
  const [paused, setPaused] = useState(false);
  const [ending, setEnding] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [line, setLine] = useState("");

  // Speakers: checked-in crew first, otherwise everyone on the job.
  const checkedIn = Object.values(form.crew).filter((c) => c.checked_in_at).map((c) => c.user_id);
  const speakers = checkedIn.length ? checkedIn : session.crew_member_ids;
  const [speaker, setSpeaker] = useState(() => (user && speakers.includes(user.id) ? user.id : (speakers[0] ?? "")));

  const sockRef = useRef<DeviceSocket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const recRef = useRef<SpeechRecognizer | null>(null);
  const levelRef = useRef<HTMLSpanElement>(null);
  const sttFallback = useRef(false);
  const micRef = useRef<Mic>("off");
  micRef.current = mic;
  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  const t0 = useRef(Date.now());
  const holdRef = useRef(false);
  holdRef.current = speaking || paused || ending;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // --- demo script ---------------------------------------------------------------------------
  const [scenarioId, setScenarioId] = useState(() => storedScenario(session.id) ?? "");
  const [speed, setSpeed] = useState<number>(1);
  const scenario = scenarioById(scenarioId);
  const lines = scenario?.lines ?? NO_LINES;
  const player = useScriptPlayer(
    lines,
    speed,
    (l) => {
      sockRef.current?.sendTranscript({
        text: l.text,
        speaker_user_id: l.speaker,
        confidence: 0.95,
        start_ms: l.at_ms,
        end_ms: l.at_ms + Math.max(1500, l.text.length * 55),
      });
      setSpeaker(l.speaker);
    },
    holdRef,
  );

  // --- device socket -------------------------------------------------------------------------
  const onDeviceError = useRef<(e: DeviceError) => void>(() => undefined);
  onDeviceError.current = (e) => {
    if (e.code === "stt_unavailable_local" || e.code === "stt_failed") {
      sttFallback.current = true;
      if (micRef.current === "audio" || micRef.current === "starting") {
        void stopCapture().then(() => {
          sockRef.current?.setMode("text");
          startSpeech();
        });
        toast.push("info", "Using this device's speech recognition", "Audio can't be transcribed in local mode.");
      }
      return;
    }
    toast.push("warning", "Briefing connection", e.message ?? e.code);
  };

  useEffect(() => {
    const sock = new DeviceSocket({
      sessionId: session.id,
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
  }, [session.id]);

  // Release the microphone and silence prompts when leaving the screen.
  useEffect(
    () => () => {
      recRef.current?.stop();
      void captureRef.current?.stop();
      stopPrompt();
    },
    [],
  );

  // --- voice prompts -------------------------------------------------------------------------
  const spoken = useRef(new Set<string>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const latestPrompt = prompts[prompts.length - 1];

  const say = (p: ReceivedPrompt) => {
    chain.current = chain.current.then(async () => {
      setSpeaking(true);
      // Don't transcribe CrewBrief's own voice.
      const listening = micRef.current === "speech";
      if (listening) recRef.current?.stop();
      captureRef.current?.pause();
      try {
        await playPrompt(p);
      } finally {
        captureRef.current?.resume();
        if (listening && micRef.current === "speech") restartSpeech();
        setSpeaking(false);
      }
    });
  };

  useEffect(() => {
    if (!latestPrompt || spoken.current.has(latestPrompt.id)) return;
    spoken.current.add(latestPrompt.id);
    if (voiceOnRef.current) say(latestPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPrompt?.id]);

  // --- capture -------------------------------------------------------------------------------
  const sendLine = (text: string, confidence = 0.95) => {
    const now = Date.now() - t0.current;
    sockRef.current?.sendTranscript({
      text,
      speaker_user_id: speakerRef.current,
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
      toast.push("warning", "Speech recognition isn't available in this browser", "Type lines below, or play the demo script.");
      return;
    }
    try {
      restartSpeech();
      setMic("speech");
    } catch (err) {
      setMic("off");
      toast.error(err, "Could not start listening");
    }
  };

  const startMic = async () => {
    if (paused || !sockRef.current) return;
    const reason = audioUnsupportedReason();
    if (!sttFallback.current && !reason) {
      setMic("starting");
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
        // The gateway may already have told us it can't transcribe (switches us to speech).
        if (captureRef.current === cap) setMic("audio");
        return;
      } catch (err) {
        await stopCapture();
        sockRef.current?.setMode("text");
        toast.push("warning", "Microphone unavailable", err instanceof Error ? err.message : undefined);
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
    if (sockRef.current?.currentMode === "audio") sockRef.current.setMode("text");
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    sockRef.current?.setPaused(next);
    if (next) {
      void stopMic();
      player.pause();
    }
  };

  const submitLine = (e: FormEvent) => {
    e.preventDefault();
    const text = line.trim();
    if (!text || paused) return;
    sendLine(text);
    setLine("");
  };

  const endBriefing = async () => {
    setEnding(true);
    player.pause();
    await stopMic();
    stopPrompt();
    sockRef.current?.setPaused(true);
    await new Promise((r) => window.setTimeout(r, END_FLUSH_MS));
    try {
      const s = await api.endBriefing(session.id);
      qc.setQueryData<SessionDetail>(qk.session(session.id), (d) => (d ? { ...d, session: s } : d));
      void qc.invalidateQueries({ queryKey: qk.session(session.id) });
      void qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (err) {
      toast.error(err, "Could not end the briefing");
      sockRef.current?.setPaused(paused);
      setEnding(false);
    }
  };

  const recording = session.recording === "active" && !paused;
  const micLabel: Record<Mic, string> = {
    off: "Tap to talk",
    starting: "Starting mic…",
    audio: "Listening — tap to stop",
    speech: "Listening — tap to stop",
  };

  return (
    <div className="live-grid">
      {ending && (
        <div className="finalising" role="status">
          <span className="spinner spinner-lg" aria-hidden="true" />
          <h2>Finalising the form…</h2>
          <p className="muted">CrewBrief is running a last check for gaps before it goes to your supervisor.</p>
        </div>
      )}

      <div className="live-col">
        <PromptCard
          prompt={latestPrompt}
          speaking={speaking}
          answered={!!latestPrompt && !detail.gaps.some((g) => g.id === latestPrompt.gap_id && g.status === "open")}
          onReplay={() => latestPrompt && say(latestPrompt)}
        />

        <section className="card crew-card mic-card" aria-label="Briefing controls">
          <div className="mic-status">
            <span className={`rec ${recording ? "rec-active" : "rec-paused"}`}>
              {recording ? (
                <>
                  <span className="rec-dot" aria-hidden="true" /> Recording active
                </>
              ) : paused ? (
                "❚❚ Paused — nothing is being captured"
              ) : (
                "Connecting…"
              )}
            </span>
            <span className={`conn conn-${conn}`} title={closedReason}>
              {conn === "online" ? "Device connected" : conn === "closed" ? `Disconnected${closedReason ? `: ${closedReason}` : ""}` : "Connecting…"}
            </span>
          </div>

          <button
            type="button"
            className={`mic-btn${mic === "audio" || mic === "speech" ? " mic-on" : ""}`}
            aria-pressed={mic === "audio" || mic === "speech"}
            disabled={paused || ending || mic === "starting"}
            onClick={() => void (mic === "off" ? startMic() : stopMic())}
          >
            <span className="mic-icon" aria-hidden="true">
              🎙
            </span>
            <span>{micLabel[mic]}</span>
          </button>
          <span className="level" aria-hidden="true">
            <span ref={levelRef} />
          </span>
          {mic === "speech" && <p className="muted small center">On-device speech recognition (en-AU)</p>}
          {interim && <p className="interim">“{interim}”</p>}

          <div className="speaker-pick" role="group" aria-label="Who is speaking">
            <span className="field-label-lg">Speaking</span>
            <div className="speaker-chips">
              {speakers.map((id) => (
                <button key={id} type="button" className="speaker-chip" aria-pressed={speaker === id} onClick={() => setSpeaker(id)}>
                  <span className="avatar" aria-hidden="true">
                    {nameOf(id).charAt(0)}
                  </span>
                  {nameOf(id)}
                </button>
              ))}
            </div>
          </div>

          <form className="type-line" onSubmit={submitLine}>
            <label className="sr-only" htmlFor="type-line">
              Type a line
            </label>
            <input
              id="type-line"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              placeholder={`Type a line as ${nameOf(speaker)}…`}
              disabled={paused || ending}
              maxLength={2000}
            />
            <button type="submit" className="btn btn-large" disabled={!line.trim() || paused || ending}>
              Send
            </button>
          </form>

          <div className="live-actions">
            <button type="button" className="btn btn-large" onClick={togglePause} disabled={ending}>
              {paused ? "▶ Resume recording" : "❚❚ Pause recording"}
            </button>
            <button type="button" className="btn btn-large btn-danger" onClick={() => void endBriefing()} disabled={ending}>
              End briefing
            </button>
          </div>
          <label className="check small">
            <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> Speak CrewBrief's questions out
            loud
          </label>
        </section>

        <section className="card crew-card demo-card" aria-labelledby="demo-title">
          <div className="demo-head">
            <h2 id="demo-title">Demo script</h2>
            <span className="muted small">
              {lines.length ? `${player.next}/${lines.length} lines` : "No script selected"}
            </span>
          </div>
          <label className="field">
            <span>Scenario</span>
            <select
              value={scenarioId}
              onChange={(e) => {
                setScenarioId(e.target.value);
                rememberScenario(session.id, e.target.value || null);
              }}
              disabled={player.status === "playing"}
            >
              <option value="">— Choose a scripted briefing —</option>
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
              <button type="button" className="btn btn-large" onClick={player.pause}>
                ❚❚ Pause script
              </button>
            ) : player.status === "done" ? (
              <button type="button" className="btn btn-large" onClick={player.restart}>
                ↺ Restart
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-large"
                onClick={player.play}
                disabled={!lines.length || paused || ending || conn === "closed"}
              >
                ▶ {player.status === "paused" ? "Resume script" : "Play demo script"}
              </button>
            )}
          </div>
          {lines.length > 0 && (
            <div className="progress" aria-hidden="true">
              <span style={{ width: `${(player.next / lines.length) * 100}%` }} />
            </div>
          )}
          {player.current ? (
            <blockquote className={`now-speaking${player.status === "playing" ? " is-playing" : ""}`} aria-live="polite">
              <span className="now-speaker">
                {player.status === "playing" && <span className="wave" aria-hidden="true" />}
                {nameOf(player.current.speaker)}
              </span>
              “{player.current.text}”
            </blockquote>
          ) : (
            scenario && <p className="muted small">{scenario.summary}</p>
          )}
          {speaking && player.status === "playing" && <p className="muted small">Waiting while CrewBrief asks its question…</p>}
        </section>

        <section className="card crew-card" aria-labelledby="tail-title">
          <h2 id="tail-title">What CrewBrief heard</h2>
          <TranscriptTail segments={segments} nameOf={nameOf} />
        </section>
      </div>

      <div className="live-col live-col-wide">
        <section className="card crew-card" aria-labelledby="form-title">
          <div className="demo-head">
            <h2 id="form-title">Hazard assessment</h2>
            <span className="live live-open">
              <span className="live-dot" aria-hidden="true" /> Filling in live
            </span>
          </div>
          <CrewForm form={form} live />
        </section>
        <CrewGaps gaps={detail.gaps} />
      </div>
    </div>
  );
}

function PromptCard({
  prompt,
  speaking,
  answered,
  onReplay,
}: {
  prompt: ReceivedPrompt | undefined;
  speaking: boolean;
  answered: boolean;
  onReplay: () => void;
}) {
  if (!prompt) {
    return (
      <section className="prompt-card prompt-idle" aria-live="polite">
        <span className="prompt-icon" aria-hidden="true">
          💬
        </span>
        <p>CrewBrief will ask out loud if something important is missing, like a control for a critical hazard.</p>
      </section>
    );
  }
  return (
    <section
      className={`prompt-card${speaking ? " prompt-speaking" : ""}${answered && !speaking ? " prompt-answered" : ""}`}
      aria-live="assertive"
      key={prompt.id}
    >
      <div className="prompt-head">
        <span className="prompt-icon" aria-hidden="true">
          {speaking ? "🔊" : "💬"}
        </span>
        <span className="prompt-label">{answered && !speaking ? "✓ Answered" : "CrewBrief asks"}</span>
        <button type="button" className="btn btn-small" onClick={onReplay} disabled={speaking}>
          Replay
        </button>
      </div>
      <p className="prompt-text">{prompt.text}</p>
      <p className="small prompt-hint">
        {answered && !speaking ? "The crew's answer closed this gap." : "Answer out loud. The reply fills in the form."}
      </p>
    </section>
  );
}
