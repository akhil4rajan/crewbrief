import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { qk, useLibraryIndex, useUserDirectory } from "../api/queries";
import type { Session, SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { EmptyState, InlineError, Skeleton, StateBadge } from "../components/Feedback";
import { useToast } from "../components/Toasts";
import { formatDateTime } from "../format";
import { useSessionLive } from "../realtime/useSessionLive";
import { CrewForm, CrewGaps } from "./CrewForm";
import { LiveBriefing } from "./LiveBriefing";

const POLL_WHEN_OFFLINE_MS = 5_000;
const LIVE = new Set(["BRIEFING", "DRAFTING", "GAP_CHECK"]);

export function CrewBriefingPage() {
  const { sessionId = "" } = useParams();
  const live = useSessionLive(sessionId);
  const users = useUserDirectory();
  const polling = live.status === "open" ? false : POLL_WHEN_OFFLINE_MS;
  const detail = useQuery({ queryKey: qk.session(sessionId), queryFn: () => api.session(sessionId), refetchInterval: polling });
  const transcript = useQuery({
    queryKey: qk.transcript(sessionId),
    queryFn: () => api.transcript(sessionId),
    refetchInterval: polling,
  });
  const nameOf = (id: string | null) => (id ? (users.get(id)?.name ?? id) : "Unknown speaker");

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
          ← My briefings
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
  return (
    <div className={`crew-page${LIVE.has(state) ? " crew-page-wide" : ""}`}>
      <BriefingHeader session={d.session} />
      <ErrorBoundary label="This part of the briefing failed to render">
        {state === "CREATED" && <PreBrief detail={d} nameOf={nameOf} />}
        {LIVE.has(state) && (
          <LiveBriefing detail={d} segments={transcript.data ?? []} prompts={live.prompts} nameOf={nameOf} />
        )}
        {(state === "REVIEW" || state === "SIGNED" || state === "SUBMITTED") && <CrewReview detail={d} nameOf={nameOf} />}
        {state === "ABANDONED" && (
          <EmptyState title="This briefing was abandoned">{d.session.abandon_reason ?? "No reason was given."}</EmptyState>
        )}
      </ErrorBoundary>
    </div>
  );
}

function BriefingHeader({ session }: { session: Session }) {
  const { taskTypeName } = useLibraryIndex();
  return (
    <header className="crew-briefing-head">
      <Link to="/crew" className="back-link">
        ← My briefings
      </Link>
      <div className="session-title-row">
        <h1>{session.title}</h1>
        <StateBadge state={session.state} />
      </div>
      <p className="muted">
        {taskTypeName(session.task_type)} · {session.location ?? "No location"}
      </p>
    </header>
  );
}

function useUpdateDetail(sessionId: string) {
  const qc = useQueryClient();
  return {
    detail: (d: SessionDetail) => qc.setQueryData(qk.session(sessionId), d),
    session: (s: Session) => qc.setQueryData<SessionDetail>(qk.session(sessionId), (d) => (d ? { ...d, session: s } : d)),
  };
}

// --- CREATED: tap in, consent, start --------------------------------------------------------

function PreBrief({ detail, nameOf }: { detail: SessionDetail; nameOf: (id: string | null) => string }) {
  const toast = useToast();
  const session = detail.session;
  const update = useUpdateDetail(session.id);
  const crew = detail.draft.form.crew;
  const isIn = (id: string) => !!crew[id]?.checked_in_at;
  const members = session.crew_member_ids;
  const inCount = members.filter(isIn).length;
  const consented = !!session.consent_acknowledged_at;

  const checkIn = useMutation({
    mutationFn: (userId: string) => api.checkIn(session.id, userId),
    onSuccess: update.detail,
    onError: (err) => toast.error(err, "Could not tap in"),
  });
  const tapInAll = async () => {
    for (const id of members.filter((m) => !isIn(m))) await checkIn.mutateAsync(id).catch(() => undefined);
  };
  const consent = useMutation({
    mutationFn: () => api.consent(session.id),
    onSuccess: update.session,
    onError: (err) => toast.error(err, "Could not record consent"),
  });
  const start = useMutation({
    mutationFn: () => api.start(session.id),
    onSuccess: update.session,
    onError: (err) =>
      err instanceof ApiError && err.code === "consent_required"
        ? toast.push("warning", "Acknowledge the recording notice first")
        : toast.error(err, "Could not start the briefing"),
  });

  return (
    <div className="prebrief">
      <section className="card crew-card step-card" aria-labelledby="tap-title">
        <div className="step-card-head">
          <span className={`step-num${inCount > 0 ? " done" : ""}`}>1</span>
          <div>
            <h2 id="tap-title">Tap in</h2>
            <p className="muted small">Each crew member taps their name so the form knows who is on the job.</p>
          </div>
          <span className="muted small nowrap">
            {inCount}/{members.length} in
          </span>
        </div>
        <ul className="tap-list">
          {members.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={`tap-btn${isIn(id) ? " tapped" : ""}`}
                aria-pressed={isIn(id)}
                disabled={isIn(id) || checkIn.isPending}
                onClick={() => checkIn.mutate(id)}
              >
                <span className="avatar" aria-hidden="true">
                  {nameOf(id).charAt(0)}
                </span>
                <span className="tap-name">{nameOf(id)}</span>
                <span className="tap-state">{isIn(id) ? "✓ Tapped in" : "Tap in"}</span>
              </button>
            </li>
          ))}
        </ul>
        {members.length > 1 && inCount < members.length && (
          <button type="button" className="btn btn-ghost" onClick={() => void tapInAll()} disabled={checkIn.isPending}>
            Tap in everyone
          </button>
        )}
      </section>

      <section className="card crew-card step-card" aria-labelledby="consent-title">
        <div className="step-card-head">
          <span className={`step-num${consented ? " done" : ""}`}>2</span>
          <div>
            <h2 id="consent-title">Recording notice</h2>
            <p className="muted small">Read this out to the crew before you start.</p>
          </div>
        </div>
        <ul className="notice">
          <li>
            <span className="rec-dot" aria-hidden="true" /> A <strong>recording active</strong> indicator shows whenever
            CrewBrief is listening.
          </li>
          <li>
            <span aria-hidden="true">❚❚</span> Anyone can ask to <strong>pause</strong> at any time.
          </li>
          <li>
            <span aria-hidden="true">🔇</span> <strong>Raw audio is not stored.</strong> Only the text transcript is kept.
          </li>
          <li>
            <span aria-hidden="true">🛡</span> Transcripts are <strong>redacted for personal information</strong> such as phone
            numbers and names of the public.
          </li>
        </ul>
        {consented ? (
          <p className="ok-text">✓ Notice acknowledged {formatDateTime(session.consent_acknowledged_at)}</p>
        ) : (
          <button type="button" className="btn btn-large" onClick={() => consent.mutate()} disabled={consent.isPending}>
            {consent.isPending ? "Saving…" : "Acknowledge"}
          </button>
        )}
      </section>

      <section className="card crew-card step-card" aria-labelledby="start-title">
        <div className="step-card-head">
          <span className="step-num">3</span>
          <div>
            <h2 id="start-title">Start the briefing</h2>
            <p className="muted small">Talk through the job as normal. The form fills in as you go.</p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-large btn-block"
          onClick={() => start.mutate()}
          disabled={!consented || inCount === 0 || start.isPending}
        >
          {start.isPending ? "Starting…" : "Start briefing"}
        </button>
        {(!consented || inCount === 0) && (
          <p className="muted small center">
            {inCount === 0 ? "Tap in at least one crew member" : "Acknowledge the recording notice"} to start.
          </p>
        )}
      </section>
    </div>
  );
}

// --- REVIEW and later: read-only summary + acknowledgement -----------------------------------

function CrewReview({ detail, nameOf }: { detail: SessionDetail; nameOf: (id: string | null) => string }) {
  const { user } = useAuth();
  const toast = useToast();
  const session = detail.session;
  const update = useUpdateDetail(session.id);
  const crew = Object.values(detail.draft.form.crew);
  const me = user ? detail.draft.form.crew[user.id] : undefined;
  const onJob = !!user && (session.crew_member_ids.includes(user.id) || !!me);

  const ack = useMutation({
    mutationFn: () => api.acknowledge(session.id),
    onSuccess: (d) => {
      update.detail(d);
      toast.push("success", "Thanks, you've confirmed the form");
    },
    onError: (err) => toast.error(err, "Could not record your acknowledgement"),
  });

  const banner =
    session.state === "REVIEW"
      ? { title: "Draft complete", body: "Your supervisor will review the form and sign off. You can read it below." }
      : session.state === "SIGNED"
        ? {
            title: "Signed off",
            body: `Signed by ${nameOf(session.signed_by)} on ${formatDateTime(session.signed_at)}.`,
          }
        : { title: "Submitted", body: `Signed off and submitted${session.submission_ref ? ` (${session.submission_ref})` : ""}.` };

  return (
    <div className="review-crew">
      <section className={`card crew-card review-banner banner-${session.state.toLowerCase()}`}>
        <span className="banner-icon" aria-hidden="true">
          {session.state === "REVIEW" ? "📋" : "✅"}
        </span>
        <div>
          <h2>{banner.title}</h2>
          <p>{banner.body}</p>
        </div>
      </section>

      <div className="review-crew-grid">
        <div className="live-col">
          <section className="card crew-card" aria-labelledby="ack-title">
            <h2 id="ack-title">Crew acknowledgement</h2>
            <ul className="ack-list">
              {crew.map((c) => (
                <li key={c.user_id} className={c.acknowledged ? "acked" : ""}>
                  <span className="avatar" aria-hidden="true">
                    {c.name.charAt(0)}
                  </span>
                  <span className="tap-name">{c.name}</span>
                  <span className={c.acknowledged ? "ok-text" : "muted"}>{c.acknowledged ? "✓ Read" : "Not yet"}</span>
                </li>
              ))}
            </ul>
            {onJob && !me?.acknowledged && (
              <button type="button" className="btn btn-primary btn-large btn-block" onClick={() => ack.mutate()} disabled={ack.isPending}>
                {ack.isPending ? "Saving…" : "I've read the form"}
              </button>
            )}
            {me?.acknowledged && <p className="ok-text">✓ You've confirmed you read the form.</p>}
          </section>
          <CrewGaps gaps={detail.gaps} title="Open gaps for the supervisor" />
        </div>
        <section className="card crew-card live-col-wide" aria-labelledby="draft-title">
          <div className="demo-head">
            <h2 id="draft-title">Hazard assessment</h2>
            <span className="muted small">Read only · revision {detail.draft.revision}</span>
          </div>
          <CrewForm form={detail.draft.form} />
        </section>
      </div>
    </div>
  );
}
