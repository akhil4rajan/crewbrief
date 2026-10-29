import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { qk, useLibraryIndex, useUserDirectory } from "../api/queries";
import type { Session } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { isCrew, useSwitchArea } from "../auth/roles";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { EmptyState, InlineError, Skeleton, StateBadge } from "../components/Feedback";
import { formatDateTime, formatTime } from "../format";
import { useSessionLive, type LiveStatus } from "../realtime/useSessionLive";
import { SessionActions } from "../session/Actions";
import { AuditTab } from "../session/AuditTab";
import { DiffTab } from "../session/DiffTab";
import { FormPane } from "../session/FormPane";
import { GapsPane } from "../session/GapsPane";
import { actionPermissions } from "../session/permissions";
import { SessionProvider } from "../session/SessionContext";
import { TranscriptPane } from "../session/TranscriptPane";

const POLL_WHEN_OFFLINE_MS = 10_000;

type TabId = "review" | "audit" | "diff";

export function SessionPage() {
  const { sessionId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
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
      <div className="page">
        <Skeleton lines={2} height={28} />
        <div className="review-grid">
          <Skeleton lines={12} />
          <Skeleton lines={8} />
          <Skeleton lines={5} />
        </div>
      </div>
    );
  }
  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="page">
        <Link to="/sessions" className="back-link">
          ← Briefings
        </Link>
        {notFound ? (
          <EmptyState title="Session not found">It may have been removed, or the link is wrong.</EmptyState>
        ) : (
          <InlineError error={detail.error} onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }

  const d = detail.data;
  const canAudit = actionPermissions(user, d.session).viewAudit.allowed;
  const requested = params.get("tab") as TabId | null;
  const tab: TabId = requested && (requested === "review" || canAudit) ? requested : "review";
  const tabs: { id: TabId; label: string }[] = [
    { id: "review", label: "Live review" },
    ...(canAudit ? ([{ id: "audit", label: "Audit" }, { id: "diff", label: "AI vs final" }] as const) : []),
  ];

  return (
    <SessionProvider detail={d} segments={transcript.data ?? []}>
      <div className="page page-wide">
        <SessionHeader session={d.session} revision={d.draft.revision} liveStatus={live.status} />
        <SessionActions detail={d} />

        <div className="tabs" role="tablist" aria-label="Session views">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`stab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`spanel-${t.id}`}
              className="tab"
              onClick={() => setParams(t.id === "review" ? {} : { tab: t.id }, { replace: true })}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`spanel-${tab}`} aria-labelledby={`stab-${tab}`}>
          {tab === "review" && (
            <div className="review-grid">
              <section className="pane form-col" aria-labelledby="form-title">
                <header className="pane-head">
                  <h2 id="form-title">Draft form</h2>
                  <span className="muted small">Revision {d.draft.revision}</span>
                </header>
                <ErrorBoundary label="The form failed to render">
                  <FormPane presence={live.presence} />
                </ErrorBoundary>
              </section>
              <div className="side-col">
                <ErrorBoundary label="The transcript failed to render">
                  <TranscriptPane loading={transcript.isPending} prompts={live.prompts} />
                </ErrorBoundary>
              </div>
              <div className="gaps-col">
                <ErrorBoundary label="Gaps failed to render">
                  <GapsPane />
                </ErrorBoundary>
              </div>
            </div>
          )}
          {tab === "audit" && <AuditTab sessionId={sessionId} />}
          {tab === "diff" && <DiffTab sessionId={sessionId} />}
        </div>
      </div>
    </SessionProvider>
  );
}

const LIVE_LABEL: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  open: "Live updates on",
  reconnecting: "Reconnecting…",
  offline: "Offline — polling",
};

function SessionHeader({ session, revision, liveStatus }: { session: Session; revision: number; liveStatus: LiveStatus }) {
  const { taskTypeName } = useLibraryIndex();
  const users = useUserDirectory();
  const { mode, user } = useAuth();
  const switchArea = useSwitchArea();
  const supervisor = session.supervisor_id ? (users.get(session.supervisor_id)?.name ?? session.supervisor_id) : "Unassigned";

  return (
    <header className="session-header">
      <div className="session-header-top">
        <Link to="/sessions" className="back-link">
          ← Briefings
        </Link>
        {(mode === "dev" || isCrew(user)) && (
          <button
            type="button"
            className="btn btn-ghost btn-small"
            title="Switch to a crew member on this job and open their view"
            onClick={() => void switchArea("crew", `/crew/briefings/${session.id}`, session.crew_member_ids)}
          >
            Open crew view ↗
          </button>
        )}
      </div>
      <div className="session-title-row">
        <h1>{session.title}</h1>
        <StateBadge state={session.state} />
        <span className={`live live-${liveStatus}`} role="status" title={`Revision ${revision}`}>
          <span className="live-dot" aria-hidden="true" />
          {LIVE_LABEL[liveStatus]}
        </span>
      </div>
      <dl className="meta-row">
        <div>
          <dt>Task</dt>
          <dd>{taskTypeName(session.task_type)}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{session.location ?? "—"}</dd>
        </div>
        {session.work_order_id && (
          <div>
            <dt>Work order</dt>
            <dd className="mono">{session.work_order_id}</dd>
          </div>
        )}
        <div>
          <dt>Supervisor</dt>
          <dd>{supervisor}</dd>
        </div>
        <div>
          <dt>Recording</dt>
          <dd>
            <RecordingIndicator session={session} />
          </dd>
        </div>
        <div>
          <dt>Consent</dt>
          <dd>
            {session.consent_acknowledged_at ? (
              <span className="ok-text" title={formatDateTime(session.consent_acknowledged_at)}>
                ✓ Notice given {formatTime(session.consent_acknowledged_at)}
              </span>
            ) : (
              <span className="warn-text">No consent notice recorded</span>
            )}
          </dd>
        </div>
        {session.signed_at && (
          <div>
            <dt>Signed</dt>
            <dd>
              {users.get(session.signed_by ?? "")?.name ?? session.signed_by} · {formatDateTime(session.signed_at)}
            </dd>
          </div>
        )}
        {session.submission_ref && (
          <div>
            <dt>Submission</dt>
            <dd className="mono">{session.submission_ref}</dd>
          </div>
        )}
        {session.abandon_reason && (
          <div>
            <dt>Abandoned</dt>
            <dd>{session.abandon_reason}</dd>
          </div>
        )}
      </dl>
    </header>
  );
}

function RecordingIndicator({ session }: { session: Session }) {
  if (session.recording === "active") {
    return (
      <span className="rec rec-active">
        <span className="rec-dot" aria-hidden="true" /> Recording
      </span>
    );
  }
  if (session.recording === "paused") return <span className="rec rec-paused">❚❚ Paused</span>;
  return <span className="muted">Not recording</span>;
}
