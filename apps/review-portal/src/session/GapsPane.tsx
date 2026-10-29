import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { Gap, GapSeverity, SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, GapSeverityBadge } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { formatTime, humanize } from "../format";
import { actionPermissions } from "./permissions";
import { useSessionUi } from "./SessionContext";

const ORDER: Record<GapSeverity, number> = { blocking: 0, warning: 1, info: 2 };

export function GapsPane() {
  const { detail, focusPath } = useSessionUi();
  const { user } = useAuth();
  const [showClosed, setShowClosed] = useState(false);
  const [dismissing, setDismissing] = useState<Gap | null>(null);
  const perm = actionPermissions(user, detail.session).dismissGap;

  const open = detail.gaps.filter((g) => g.status === "open").sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const closed = detail.gaps.filter((g) => g.status !== "open");
  const counts = (["blocking", "warning", "info"] as const).map((s) => [s, open.filter((g) => g.severity === s).length] as const);

  return (
    <section className="pane gaps-pane" aria-labelledby="gaps-title">
      <header className="pane-head">
        <h2 id="gaps-title">
          Gaps <span className="count">{open.length}</span>
        </h2>
        <div className="gap-summary" aria-label="Open gaps by severity">
          {counts.map(([s, n]) => (
            <span key={s} className={`gap-pill gap-${s}${n ? "" : " is-zero"}`}>
              {n} {s}
            </span>
          ))}
        </div>
      </header>
      {open.length === 0 ? (
        <EmptyState title="No open gaps">The verifier has not raised anything that needs attention.</EmptyState>
      ) : (
        <ul className="gap-list">
          {open.map((g) => (
            <GapCard key={g.id} gap={g} onFocus={() => focusPath(g.path)} onDismiss={perm.allowed ? () => setDismissing(g) : undefined} />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div className="closed-gaps">
          <button type="button" className="btn btn-ghost btn-small" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Hide" : "Show"} resolved & dismissed ({closed.length})
          </button>
          {showClosed && (
            <ul className="gap-list">
              {closed.map((g) => (
                <GapCard key={g.id} gap={g} onFocus={() => focusPath(g.path)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {dismissing && <DismissDialog gap={dismissing} sessionId={detail.session.id} onClose={() => setDismissing(null)} />}
    </section>
  );
}

function GapCard({ gap, onFocus, onDismiss }: { gap: Gap; onFocus: () => void; onDismiss?: () => void }) {
  return (
    <li className={`gap gap-card-${gap.severity} gap-status-${gap.status}`}>
      <button type="button" className="gap-main" onClick={onFocus} title="Show this field on the form">
        <span className="gap-top">
          <GapSeverityBadge severity={gap.severity} />
          <span className="muted small">{humanize(gap.kind)}</span>
        </span>
        <span className="gap-message">{gap.message}</span>
        {gap.question && (
          <span className="gap-question">
            <span aria-hidden="true">🗣</span> “{gap.question}”
            {gap.asked_at && <span className="muted small"> · asked {formatTime(gap.asked_at)}</span>}
          </span>
        )}
        <span className="muted small mono">{gap.path}</span>
        {gap.status !== "open" && (
          <span className="small">
            {humanize(gap.status)}
            {gap.resolution && `: ${gap.resolution}`}
          </span>
        )}
      </button>
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </li>
  );
}

function DismissDialog({ gap, sessionId, onClose }: { gap: Gap; sessionId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const dismiss = useMutation({
    mutationFn: () => api.dismissGap(sessionId, gap.id, reason.trim()),
    onSuccess: (updated) => {
      qc.setQueryData<SessionDetail>(qk.session(sessionId), (d) =>
        d ? { ...d, gaps: d.gaps.map((g) => (g.id === updated.id ? updated : g)) } : d,
      );
      toast.push("success", "Gap dismissed");
      onClose();
    },
    onError: (err) => toast.error(err, "Could not dismiss the gap"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) dismiss.mutate();
  };

  return (
    <Modal
      title="Dismiss gap"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="dismiss-gap" className="btn btn-primary" disabled={!reason.trim() || dismiss.isPending}>
            Dismiss gap
          </button>
        </>
      }
    >
      <p>
        <GapSeverityBadge severity={gap.severity} /> {gap.message}
      </p>
      <form id="dismiss-gap" onSubmit={submit}>
        <label className="field">
          <span>Reason (recorded in the audit log) *</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus maxLength={500} />
        </label>
      </form>
    </Modal>
  );
}
