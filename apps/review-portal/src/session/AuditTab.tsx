import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { api } from "../api/endpoints";
import { qk, useUserDirectory } from "../api/queries";
import type { AuditEntry } from "../api/types";
import { EmptyState, InlineError, Skeleton } from "../components/Feedback";
import { formatDateTime, humanize } from "../format";

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function AuditTab({ sessionId }: { sessionId: string }) {
  const audit = useQuery({ queryKey: qk.audit(sessionId), queryFn: () => api.audit(sessionId), refetchInterval: 15_000 });
  const users = useUserDirectory();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  if (audit.isPending) return <Skeleton lines={8} height={28} />;
  if (audit.isError) return <InlineError error={audit.error} onRetry={() => void audit.refetch()} />;
  const actions = Array.from(new Set(audit.data.map((e) => e.action))).sort();
  const rows = [...audit.data]
    .filter((e) => !filter || e.action === filter)
    .sort((a, b) => b.ts.localeCompare(a.ts));

  const actor = (e: AuditEntry) => (e.actor_type === "user" ? (users.get(e.actor_id)?.name ?? e.actor_id) : e.actor_id);

  return (
    <div className="card">
      <div className="toolbar">
        <label className="inline-select">
          <span>Action</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All ({audit.data.length})</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No audit entries" />
      ) : (
        <div className="table-wrap">
          <table className="table audit-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Path</th>
                <th scope="col">Model / prompt</th>
                <th scope="col">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const open = expanded === e.id;
                return (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="nowrap">{formatDateTime(e.ts)}</td>
                      <td>
                        {actor(e)} <span className="muted small">({e.actor_type})</span>
                      </td>
                      <td>
                        <span className="badge badge-outline">{humanize(e.action)}</span>
                      </td>
                      <td className="mono small">{e.path ?? "—"}</td>
                      <td className="small">
                        {e.model ? (
                          <>
                            <span className="mono">{e.model}</span>
                            {e.prompt_version && <span className="muted"> · {e.prompt_version}</span>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-small" aria-expanded={open} onClick={() => setExpanded(open ? null : e.id)}>
                          {open ? "Hide" : "Details"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={6}>
                          <div className="detail-grid">
                            <div>
                              <h4>Before</h4>
                              <Json value={e.before} />
                            </div>
                            <div>
                              <h4>After</h4>
                              <Json value={e.after} />
                            </div>
                            <div>
                              <h4>Details</h4>
                              <Json value={Object.keys(e.details).length ? e.details : null} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
