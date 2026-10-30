import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleCheck } from "lucide-react";
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
const LOW_KEY = (sessionId: string) => `crewbrief.lowPriorityOpen.${sessionId}`;

/** Disclosure state remembered for this browser session. */
function useSessionFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      sessionStorage.setItem(key, v ? "1" : "0");
    } catch {
      // Storage unavailable: the choice lasts until the page reloads.
    }
  };
  return [value, set];
}

/** "Needs your decision": open gaps as compact rows, blocking first, each with its actions. */
export function DecisionsSection() {
  const { detail, focusPath, edit, applyEdit, humanProvenance, editing } = useSessionUi();
  const { user } = useAuth();
  const [showClosed, setShowClosed] = useState(false);
  const [dismissing, setDismissing] = useState<Gap | null>(null);
  const perm = actionPermissions(user, detail.session).dismissGap;

  const open = detail.gaps.filter((g) => g.status === "open").sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const closed = detail.gaps.filter((g) => g.status !== "open");
  const blocking = open.filter((g) => g.severity === "blocking");
  const lower = open.filter((g) => g.severity !== "blocking");
  const [showLower, setShowLower] = useSessionFlag(LOW_KEY(detail.session.id));

  const row = (g: Gap) => (
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
  );

  return (
    <section className="review-section" aria-labelledby="decide-title" data-path="/gaps" tabIndex={-1}>
      <header className="review-section-head">
        <h2 id="decide-title">Needs your decision</h2>
        {blocking.length > 0 && (
          <span className="section-meta">
            {blocking.length} to settle before sign-off
          </span>
        )}
      </header>
      {open.length === 0 ? (
        <p className="all-clear">
          <CircleCheck size={20} aria-hidden="true" />
          Nothing to decide. Every item is settled.
        </p>
      ) : blocking.length === 0 ? (
        <p className="all-clear">
          <CircleCheck size={20} aria-hidden="true" />
          Nothing blocks sign-off.
        </p>
      ) : (
        <ul className="decision-list">{blocking.map(row)}</ul>
      )}
      {lower.length > 0 && (
        <div className="disclosure">
          <button
            type="button"
            className="disclosure-btn"
            aria-expanded={showLower}
            aria-controls="lower-priority"
            onClick={() => setShowLower(!showLower)}
          >
            <ChevronDown size={16} aria-hidden="true" className="chev" />
            {showLower ? "Hide" : "Show"} {lower.length} lower-priority {lower.length === 1 ? "item" : "items"}
          </button>
          {showLower && (
            <ul id="lower-priority" className="decision-list">
              {lower.map(row)}
            </ul>
          )}
        </div>
      )}
      {closed.length > 0 && (
        <div className="disclosure">
          <button type="button" className="disclosure-btn" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>
            <ChevronDown size={16} aria-hidden="true" className="chev" />
            {showClosed ? "Hide" : "Show"} {closed.length} resolved
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
        <GapSeverityBadge severity={gap.severity} iconOnly />
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
              <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => onDecide("not_present")}>
                Not applicable
              </button>
              <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => onDecide("present")}>
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
      toast.push("success", "Dismissed");
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
      title="Dismiss item"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="dismiss-gap" className="btn btn-primary" disabled={!reason.trim() || dismiss.isPending}>
            Dismiss
          </button>
        </>
      }
    >
      <p className="dialog-subject">
        <GapSeverityBadge severity={gap.severity} iconOnly /> {gap.message}
      </p>
      <p className="muted small">The reason is kept in the audit log.</p>
      <form id="dismiss-gap" onSubmit={submit}>
        <label className="field">
          <span>Reason</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus maxLength={500} />
        </label>
      </form>
    </Modal>
  );
}
