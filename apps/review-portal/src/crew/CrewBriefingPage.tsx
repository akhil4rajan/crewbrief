import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Hand, Mic, ShieldCheck } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { qk, useLibraryIndex } from "../api/queries";
import type { Session, SessionDetail } from "../api/types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { EmptyState, InlineError, Skeleton } from "../components/Feedback";
import { useToast } from "../components/Toasts";
import { useSessionLive } from "../realtime/useSessionLive";
import { AgentStrip } from "./AgentStrip";
import { LiveBriefing } from "./LiveBriefing";
import { ReviewStep } from "./ReviewStep";

const POLL_WHEN_OFFLINE_MS = 5_000;
const LIVE = new Set(["BRIEFING", "DRAFTING", "GAP_CHECK"]);
const REVIEW = new Set(["REVIEW", "SIGNED", "SUBMITTED"]);

type Step = 0 | 1 | 2;
const STEPS = ["Record", "Clarify", "Review & submit"] as const;

function stepOf(session: Session): Step {
  if (REVIEW.has(session.state)) return 2;
  if (session.state === "GAP_CHECK" && (session.clarifications?.length ?? 0) > 0) return 1;
  return 0;
}

export function CrewBriefingPage() {
  const { sessionId = "" } = useParams();
  const live = useSessionLive(sessionId);
  const polling = live.status === "open" ? false : POLL_WHEN_OFFLINE_MS;
  const detail = useQuery({ queryKey: qk.session(sessionId), queryFn: () => api.session(sessionId), refetchInterval: polling });
  const transcript = useQuery({
    queryKey: qk.transcript(sessionId),
    queryFn: () => api.transcript(sessionId),
    refetchInterval: polling,
  });

  if (detail.isPending) {
    return (
      <div className="crew-page">
        <Skeleton lines={6} height={24} />
      </div>
    );
  }
  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="crew-page">
        <Link to="/crew" className="back-link">
          <ArrowLeft size={16} aria-hidden="true" />
          My briefings
        </Link>
        {notFound ? (
          <EmptyState title="Briefing not found">It may have been removed, or the link is wrong.</EmptyState>
        ) : (
          <InlineError error={detail.error} onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }

  const d = detail.data;
  const state = d.session.state;
  const step = stepOf(d.session);
  const recording = step === 0 && LIVE.has(state);
  return (
    <div className={`crew-page${recording ? " crew-page-wide" : step === 2 ? " crew-page-review" : " crew-page-narrow"}`}>
      <Link to="/crew" className="back-link">
        ← My briefings
      </Link>
      {step !== 2 && <BriefingTitle session={d.session} />}
      {state !== "ABANDONED" && <Stepper step={step} done={state === "SUBMITTED"} />}
      {LIVE.has(state) && <AgentStrip activity={live.agents} />}
      <ErrorBoundary label="This part of the briefing failed to render">
        {state === "CREATED" && <StartCard session={d.session} />}
        {LIVE.has(state) && <LiveBriefing detail={d} segments={transcript.data ?? []} prompts={live.prompts} agents={live.agents} />}
        {step === 2 && <ReviewStep detail={d} segments={transcript.data ?? []} transcriptLoading={transcript.isPending} />}
        {state === "ABANDONED" && (
          <EmptyState title="This briefing was abandoned">{d.session.abandon_reason ?? "No reason was given."}</EmptyState>
        )}
      </ErrorBoundary>
    </div>
  );
}

function Stepper({ step, done }: { step: Step; done: boolean }) {
  return (
    <ol className="stepper" aria-label="Briefing progress">
      {STEPS.map((label, i) => {
        const complete = i < step || (done && i === step);
        const current = i === step && !done;
        return (
          <li key={label} className={`stepper-item${complete ? " is-done" : ""}${current ? " is-current" : ""}`} aria-current={current ? "step" : undefined}>
            <span className="stepper-dot" aria-hidden="true">
              {complete ? <Check size={14} strokeWidth={3} /> : i + 1}
            </span>
            <span className="stepper-label">
              {label}
              <span className="sr-only">{complete ? " (done)" : current ? " (current step)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function BriefingTitle({ session }: { session: Session }) {
  const { taskTypeName } = useLibraryIndex();
  return (
    <header className="crew-briefing-head">
      <h1>{session.title}</h1>
      <p className="muted">
        {taskTypeName(session.task_type)} · {session.location ?? "No location"}
      </p>
    </header>
  );
}

/** Before recording: the notice to read out, then consent and start in one action. */
function StartCard({ session }: { session: Session }) {
  const toast = useToast();
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: async () => {
      if (!session.consent_acknowledged_at) await api.consent(session.id);
      return api.start(session.id);
    },
    onSuccess: (s) => qc.setQueryData<SessionDetail>(qk.session(session.id), (d) => (d ? { ...d, session: s } : d)),
    onError: (err) => toast.error(err, "Could not start recording"),
  });

  return (
    <section className="card crew-card start-card" aria-labelledby="notice-title">
      <h2 id="notice-title">Read this to the crew first</h2>
      <ul className="notice">
        <li>
          <span className="notice-icon">
            <Mic size={20} aria-hidden="true" />
          </span>
          <span>
            This device will <strong>record the briefing</strong>. A red dot shows while it's listening.
          </span>
        </li>
        <li>
          <span className="notice-icon">
            <Hand size={20} aria-hidden="true" />
          </span>
          <span>
            Anyone can ask to <strong>pause</strong> at any time.
          </span>
        </li>
        <li>
          <span className="notice-icon">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <span>
            <strong>Audio is not kept.</strong> Only the text is stored, with personal details removed.
          </span>
        </li>
      </ul>
      <button type="button" className="btn btn-primary btn-xl btn-block" onClick={() => start.mutate()} disabled={start.isPending}>
        <Mic size={20} aria-hidden="true" />
        {start.isPending ? "Starting…" : "Start recording"}
      </button>
      <p className="muted small center">Starting confirms the crew has heard this notice.</p>
    </section>
  );
}
