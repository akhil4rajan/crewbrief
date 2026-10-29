import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { DiffChange } from "../api/types";
import { EmptyState, InlineError, Skeleton } from "../components/Feedback";
import { humanize } from "../format";

/** Compact one-line rendering of a form node (FieldValue → its value, entities → name/status). */
function summarize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  if ("value" in o) return summarize(o.value);
  const parts = [o.name, o.status, o.description].filter((x) => typeof x === "string" && x) as string[];
  return parts.length ? parts.join(" · ") : JSON.stringify(v);
}

function Cell({ value, kind }: { value: unknown; kind: "before" | "after" }) {
  const text = summarize(value);
  if (!text) return <span className="muted">—</span>;
  return (
    <span className={kind === "before" ? "diff-del" : "diff-add"} title={typeof value === "object" ? JSON.stringify(value, null, 2) : undefined}>
      {text}
    </span>
  );
}

export function DiffTab({ sessionId }: { sessionId: string }) {
  const diff = useQuery({ queryKey: qk.diff(sessionId), queryFn: () => api.diff(sessionId) });
  if (diff.isPending) return <Skeleton lines={6} height={28} />;
  if (diff.isError) return <InlineError error={diff.error} onRetry={() => void diff.refetch()} />;
  const { ai_revision, final_revision, changes } = diff.data;

  return (
    <div className="card">
      <p className="muted small">
        Comparing the AI draft {ai_revision !== null ? `(revision ${ai_revision})` : "(not yet snapshotted — it is taken when review starts)"} with
        the current form (revision {final_revision}). Every human change is an accuracy signal.
      </p>
      {changes.length === 0 ? (
        <EmptyState title="No differences">Reviewers have not changed anything the AI drafted.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table diff-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Change</th>
                <th scope="col">AI draft</th>
                <th scope="col">Final</th>
                <th scope="col">By role</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c: DiffChange, i) => (
                <tr key={`${c.path}-${i}`}>
                  <td className="mono small">{c.path}</td>
                  <td>
                    <span className={`badge op-${c.op}`}>{c.op === "add" ? "Added" : c.op === "remove" ? "Removed" : "Changed"}</span>
                  </td>
                  <td>
                    <Cell value={c.before} kind="before" />
                  </td>
                  <td>
                    <Cell value={c.after} kind="after" />
                  </td>
                  <td>{c.role ? humanize(c.role) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
