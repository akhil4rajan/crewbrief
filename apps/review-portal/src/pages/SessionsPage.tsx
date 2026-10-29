import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/endpoints";
import { qk, useLibraryIndex, useUserDirectory } from "../api/queries";
import type { Gap, Session, SessionState } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, InlineError, Skeleton, StateBadge } from "../components/Feedback";
import { formatDateTime, formatRelative } from "../format";
import { NewSessionDialog } from "./NewSessionDialog";

interface Tab {
  id: string;
  label: string;
  states: SessionState[] | null;
}

const TABS: Tab[] = [
  { id: "live", label: "Live", states: ["CREATED", "BRIEFING", "DRAFTING", "GAP_CHECK"] },
  { id: "review", label: "Needs review", states: ["REVIEW"] },
  { id: "signed", label: "Signed", states: ["SIGNED"] },
  { id: "submitted", label: "Submitted", states: ["SUBMITTED"] },
  { id: "all", label: "All", states: null },
];

const REFRESH_MS = 10_000;
/** Gap counts need one request per session; cap it so a long list stays cheap. */
const MAX_GAP_LOOKUPS = 40;

export function SessionsPage() {
  const { hasRole } = useAuth();
  const [tabId, setTabId] = useState(() => (hasRole("supervisor") ? "review" : "live"));
  const [creating, setCreating] = useState(false);
  const users = useUserDirectory();
  const { taskTypeName } = useLibraryIndex();

  const sessions = useQuery({ queryKey: qk.sessions, queryFn: () => api.sessions(), refetchInterval: REFRESH_MS });
  const tab = TABS.find((t) => t.id === tabId) ?? TABS[0];

  const visible = useMemo(
    () => (sessions.data ?? []).filter((s) => !tab.states || tab.states.includes(s.state)),
    [sessions.data, tab],
  );

  const gapQueries = useQueries({
    queries: visible.slice(0, MAX_GAP_LOOKUPS).map((s) => ({
      queryKey: qk.gaps(s.id),
      queryFn: () => api.gaps(s.id),
      refetchInterval: REFRESH_MS,
      staleTime: REFRESH_MS,
    })),
  });
  const gapsById = new Map<string, Gap[] | undefined>(
    visible.slice(0, MAX_GAP_LOOKUPS).map((s, i) => [s.id, gapQueries[i]?.data]),
  );

  const countFor = (t: Tab) => (sessions.data ?? []).filter((s) => !t.states || t.states.includes(s.state)).length;
  const crewNames = (s: Session) => s.crew_member_ids.map((id) => users.get(id)?.name ?? id).join(", ") || "—";

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Briefings</h1>
          <p className="muted small">
            Updates every {REFRESH_MS / 1000}s
            {sessions.dataUpdatedAt ? ` · last refreshed ${formatRelative(new Date(sessions.dataUpdatedAt).toISOString())}` : ""}
          </p>
        </div>
        {hasRole("crew", "supervisor") && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New session
          </button>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Filter by state">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === tabId}
            aria-controls="sessions-panel"
            className="tab"
            onClick={() => setTabId(t.id)}
          >
            {t.label}
            <span className="tab-count">{sessions.data ? countFor(t) : "·"}</span>
          </button>
        ))}
      </div>

      <section id="sessions-panel" role="tabpanel" aria-labelledby={`tab-${tab.id}`} className="card">
        {sessions.isPending && <Skeleton lines={6} height={36} />}
        {sessions.isError && <InlineError error={sessions.error} onRetry={() => void sessions.refetch()} />}
        {sessions.isSuccess && visible.length === 0 && (
          <EmptyState title={`No ${tab.id === "all" ? "" : tab.label.toLowerCase() + " "}briefings`}>
            {tab.id === "review"
              ? "Briefings appear here once the crew ends the briefing and the verifier has run."
              : "Start a session to capture the crew's pre-job briefing."}
          </EmptyState>
        )}
        {visible.length > 0 && (
          <div className="table-wrap">
            <table className="table sessions-table">
              <thead>
                <tr>
                  <th scope="col">Briefing</th>
                  <th scope="col">Task type</th>
                  <th scope="col">Location</th>
                  <th scope="col">Crew</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">
                    Open gaps
                  </th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/sessions/${s.id}`} className="row-link">
                        {s.title}
                      </Link>
                      {s.work_order_id && <div className="muted small mono">{s.work_order_id}</div>}
                    </td>
                    <td>{taskTypeName(s.task_type)}</td>
                    <td>{s.location ?? "—"}</td>
                    <td className="crew-cell">{crewNames(s)}</td>
                    <td>
                      <StateBadge state={s.state} />
                      {s.recording === "active" && (
                        <span className="rec-dot" title="Recording" aria-label="Recording" />
                      )}
                    </td>
                    <td className="num">
                      <GapCount gaps={gapsById.get(s.id)} />
                    </td>
                    <td title={formatDateTime(s.updated_at)}>{formatRelative(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creating && <NewSessionDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function GapCount({ gaps }: { gaps: Gap[] | undefined }) {
  if (!gaps) return <span className="muted">—</span>;
  const open = gaps.filter((g) => g.status === "open");
  const blocking = open.filter((g) => g.severity === "blocking").length;
  if (open.length === 0) return <span className="muted">0</span>;
  return (
    <span className={blocking ? "gap-count gap-count-blocking" : "gap-count"}>
      {open.length}
      {blocking > 0 && <span className="small"> ({blocking} blocking)</span>}
    </span>
  );
}
