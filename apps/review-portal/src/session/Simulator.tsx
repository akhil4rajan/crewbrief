import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { qk, useUserDirectory } from "../api/queries";
import type { EventEnvelope, VoicePrompt } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toasts";
import { config, toWsUrl } from "../config";
import { useSessionUi } from "./SessionContext";

type Conn = "idle" | "connecting" | "ready" | "closed";

interface LogLine {
  id: number;
  text: string;
  kind: "in" | "out" | "sys";
}

/** Canned briefing for an LV service connection; speakers are assigned round-robin. */
const SAMPLE_SCRIPT = [
  "Morning all, today's job is an LV service connection at 14 Smith Street.",
  "The mains on the pole are live LV, so we isolate, lock out and tag out at the pillar before anyone touches anything.",
  "Then we test before touch to prove it dead and apply portable earths.",
  "Ground's still wet from last night's rain, so watch your footing around the pit.",
  "We're working next to the road, so cones out and Jack is spotter for traffic.",
  "Arc rated clothing and face shields on for the connection.",
  "Muster point is the corner of Smith and King Street, Priya is our first aider.",
];

const WORD_MS = 380;

/** Make the session usable end-to-end without the mobile app: acts as the crew device in text mode. */
export function Simulator() {
  const { detail } = useSessionUi();
  const { mode, getToken } = useAuth();
  const users = useUserDirectory();
  const toast = useToast();
  const qc = useQueryClient();
  const session = detail.session;

  const crewIds = session.crew_member_ids.length
    ? session.crew_member_ids
    : [...users.values()].filter((u) => u.roles.includes("crew")).map((u) => u.id);
  const nameOf = (id: string) => users.get(id)?.name ?? id;

  const [open, setOpen] = useState(false);
  const [conn, setConn] = useState<Conn>("idle");
  const [speaker, setSpeaker] = useState(crewIds[0] ?? "");
  const [text, setText] = useState("");
  const [queue, setQueue] = useState<{ speaker: string; text: string }[]>([]);
  const [speak, setSpeak] = useState(true);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const startedAt = useRef(0);
  const clock = useRef(0);
  const logId = useRef(0);
  const speakRef = useRef(speak);
  speakRef.current = speak;

  const addLog = (text: string, kind: LogLine["kind"]) =>
    setLog((l) => [...l.slice(-40), { id: ++logId.current, text, kind }]);

  useEffect(() => () => ws.current?.close(), []);
  useEffect(() => {
    if (!speaker && crewIds[0]) setSpeaker(crewIds[0]);
  }, [crewIds, speaker]);

  /** In dev auth mode each crew member gets their own token, so check-ins are genuine. */
  const tokenFor = async (userId: string): Promise<string | null> =>
    mode === "dev" ? (await api.devToken(userId)).access_token : getToken();

  const playPrompt = (p: VoicePrompt) => {
    if (!speakRef.current) return;
    if (p.audio_b64) {
      void new Audio(`data:${p.audio_format?.split(";")[0] ?? "audio/wav"};base64,${p.audio_b64}`).play().catch(() => undefined);
    } else if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(p.text);
      u.lang = "en-AU";
      window.speechSynthesis.speak(u);
    }
  };

  const prepareAndConnect = async () => {
    const holder = speaker || crewIds[0];
    if (!holder) return toast.push("warning", "Add a crew member to the session first");
    setBusy(true);
    try {
      const holderToken = await tokenFor(holder);
      if (session.state === "CREATED") {
        for (const id of crewIds) {
          if (mode === "dev" || id === holder) await api.checkIn(session.id, await tokenFor(id));
        }
        await api.consent(session.id, holderToken);
        await api.start(session.id, holderToken);
        void qc.invalidateQueries({ queryKey: qk.session(session.id) });
        addLog("Crew checked in, consent recorded, briefing started", "sys");
      }
      connect(holderToken, holder);
    } catch (err) {
      toast.error(err, "Simulator could not start the briefing");
    } finally {
      setBusy(false);
    }
  };

  const connect = (token: string | null, holder: string) => {
    ws.current?.close();
    setConn("connecting");
    const url = `${toWsUrl(config.gatewayUrl)}/ws/device/${encodeURIComponent(session.id)}?access_token=${encodeURIComponent(token ?? "")}`;
    const socket = new WebSocket(url);
    ws.current = socket;
    socket.onopen = () => {
      startedAt.current = Date.now();
      clock.current = 0;
      socket.send(JSON.stringify({ type: "start", mode: "text", device_id: `review-portal-sim-${holder}` }));
      addLog(`Device connected as ${nameOf(holder)}`, "sys");
    };
    socket.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      try {
        const data = JSON.parse(msg.data) as { type: string; payload?: Record<string, unknown> };
        if (data.type === "ready") setConn("ready");
        else if (data.type === "voice.prompt") {
          const p = (data as EventEnvelope).payload as unknown as VoicePrompt;
          addLog(`🔊 ${p.text}`, "in");
          playPrompt(p);
        } else if (data.type === "error") {
          addLog(`Error: ${String(data.payload?.code ?? "")} ${String(data.payload?.message ?? "")}`, "sys");
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    socket.onclose = (e) => {
      if (ws.current === socket) ws.current = null;
      setConn("closed");
      addLog(`Device disconnected (${e.code})`, "sys");
    };
  };

  const send = (line: { speaker: string; text: string }) => {
    const socket = ws.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const elapsed = Date.now() - startedAt.current;
    const start = Math.max(elapsed, clock.current);
    const end = start + line.text.split(/\s+/).length * WORD_MS;
    clock.current = end;
    socket.send(
      JSON.stringify({ type: "transcript", text: line.text, speaker_user_id: line.speaker, confidence: 0.94, start_ms: start, end_ms: end }),
    );
    addLog(`${nameOf(line.speaker)}: ${line.text}`, "out");
    return true;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && send({ speaker, text: text.trim() })) setText("");
  };

  const loadScript = () =>
    setQueue(SAMPLE_SCRIPT.map((t, i) => ({ text: t, speaker: crewIds[i % Math.max(crewIds.length, 1)] ?? speaker })));

  const sendNext = () => {
    const [next, ...rest] = queue;
    if (next && send(next)) setQueue(rest);
  };

  const control = (type: "pause" | "resume" | "end") => {
    ws.current?.send(JSON.stringify({ type }));
    addLog(`Sent ${type}`, "sys");
  };

  const connected = conn === "ready" || conn === "connecting";
  const closed = session.state === "SUBMITTED" || session.state === "ABANDONED" || session.state === "SIGNED";

  return (
    <section className="pane simulator" aria-labelledby="sim-title">
      <header className="pane-head">
        <h2 id="sim-title">Briefing simulator</h2>
        <button type="button" className="btn btn-ghost btn-small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </button>
      </header>
      {open && (
        <div className="stack">
          <p className="muted small">
            Development aid: acts as the crew's device over <span className="mono">/ws/device</span> in text mode, and speaks voice prompts
            aloud.
          </p>
          <div className="sim-row">
            <span className={`conn conn-${conn}`}>{conn === "ready" ? "Device connected" : conn === "connecting" ? "Connecting…" : "Not connected"}</span>
            {!connected ? (
              <button type="button" className="btn btn-small btn-primary" disabled={busy || closed || crewIds.length === 0} onClick={() => void prepareAndConnect()}>
                {session.state === "CREATED" ? "Start briefing & connect" : "Connect device"}
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-small" onClick={() => control("pause")}>
                  Pause
                </button>
                <button type="button" className="btn btn-small" onClick={() => control("resume")}>
                  Resume
                </button>
                <button type="button" className="btn btn-small" onClick={() => control("end")}>
                  End
                </button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => ws.current?.close()}>
                  Disconnect
                </button>
              </>
            )}
          </div>
          <form className="sim-form" onSubmit={submit}>
            <label className="inline-select">
              <span>Speaker</span>
              <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
                {crewIds.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
              </select>
            </label>
            <input
              aria-label="Line spoken by the selected crew member"
              placeholder={conn === "ready" ? "Type what they say…" : "Connect the device first"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={conn !== "ready"}
            />
            <button type="submit" className="btn btn-small btn-primary" disabled={conn !== "ready" || !text.trim()}>
              Send
            </button>
          </form>
          <div className="sim-row">
            <button type="button" className="btn btn-small" onClick={loadScript}>
              Load sample script
            </button>
            {queue.length > 0 && (
              <button type="button" className="btn btn-small" disabled={conn !== "ready"} onClick={sendNext}>
                Send next ({queue.length} left)
              </button>
            )}
            <label className="check small">
              <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> Speak prompts
            </label>
          </div>
          {queue[0] && (
            <p className="small muted">
              Next: <strong>{nameOf(queue[0].speaker)}</strong> — {queue[0].text}
            </p>
          )}
          {log.length > 0 && (
            <ol className="sim-log" aria-label="Device log">
              {log.map((l) => (
                <li key={l.id} className={`sim-log-${l.kind}`}>
                  {l.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
