import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { Gap, GapSeverity, SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { GapSeverityBadge } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { humanize } from "../format";
import { actionPermissions } from "./permissions";
import { useSessionUi } from "./SessionContext";

const ORDER: Record<GapSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** "Needs your decision": open gaps as compact rows, blocking first, each with its actions. */
export function DecisionsSection() {
  const { detail, focusPath, edit, applyEdit, humanProvenance, editing } = useSessionUi();
  const { user } = useAuth();
  const [showClosed, setShowClosed] = useState(false);
  const [dismissing, setDismissing] = useState<Gap | null>(null);
  const perm = actionPermissions(user, detail.session).dismissGap;

  const open = detail.gaps.filter((g) => g.status === "open").sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const closed = detail.gaps.filter((g) => g.status !== "open");
  const blocking = open.filter((g) => g.severity === "blocking").length;

  return (
    <section className="review-section" aria-labelledby="decide-title" data-path="/gaps" tabIndex={-1}>
      <header className="review-section-head">
        <h2 id="decide-title">
          Needs your decision <span className="count">{open.length}</span>
        </h2>
        {blocking > 0 && <span className="muted small">{blocking} must be settled before sign-off</span>}
      </header>
      {open.length === 0 ? (
        <p className="ok-text">✓ Nothing to decide. Every gap is resolved.</p>
      ) : (
        <ul className="decision-list">
          {open.map((g) => (
            <DecisionRow
              key={g.id}
              gap={g}
              onFocus={() => focusPath(g.path)}
              onDismiss={perm.allowed ? () => setDismissing(g) : undefined}
              onDecide={
                edit.allowed && g.kind === "unconfirmed_hazard" && g.path.startsWith("/hazards/")
                  ? (status) =>
                      void applyEdit([
                        { id: `pat_${Date.now()}`, op: "replace", path: `${g.path}/status`, value: status, provenance: humanProvenance() },
                      ])
                  : undefined
              }
              busy={editing}
            />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div className="closed-gaps">
          <button type="button" className="btn btn-ghost btn-small" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Hide" : "Show"} resolved ({closed.length})
          </button>
          {showClosed && (
            <ul className="decision-list">
              {closed.map((g) => (
                <DecisionRow key={g.id} gap={g} onFocus={() => focusPath(g.path)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {dismissing && <DismissDialog gap={dismissing} sessionId={detail.session.id} onClose={() => setDismissing(null)} />}
    </section>
  );
}

type HazardDecision = "not_present" | "present";

function DecisionRow({
  gap,
  onFocus,
  onDismiss,
  onDecide,
  busy = false,
}: {
  gap: Gap;
  onFocus: () => void;
  onDismiss?: () => void;
  onDecide?: (status: HazardDecision) => void;
  busy?: boolean;
}) {
  return (
    <li className={`decision gap-card-${gap.severity} gap-status-${gap.status}`}>
      <button type="button" className="decision-main" onClick={onFocus} title="Show this on the form">
        <GapSeverityBadge severity={gap.severity} />
        <span className="decision-text">
          {gap.message}
          {gap.status !== "open" && (
            <span className="muted small">
              {" "}
              · {humanize(gap.status)}
              {gap.resolution && `: ${gap.resolution}`}
            </span>
          )}
        </span>
      </button>
      {(onDecide || onDismiss) && (
        <div className="decision-actions">
          {onDecide && (
            <>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => onDecide("not_present")}>
                Not applicable
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => onDecide("present")}>
                Confirm present
              </button>
            </>
          )}
          {onDismiss && (
            <button type="button" className="btn btn-ghost btn-small" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
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
