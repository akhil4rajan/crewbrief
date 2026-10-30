import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, ChevronDown, FileDown, FileText, GitCompare, History, Play, Workflow } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { Session, SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { GapSeverityBadge } from "../components/Feedback";
import { Menu, type MenuItem } from "../components/Menu";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { actionPermissions, type Permission } from "./permissions";
import { useSessionUi } from "./SessionContext";

type Dialog = "sign-off" | "abandon" | "submit" | null;

const MIN_JUSTIFICATION = 10;

/**
 * The review header's actions: one primary action for the current state (Sign off, then Submit)
 * and a "More" menu for everything else. Disabled actions stay visible and say why. The primary
 * action is hidden while the crew lead is on the Check sub-step.
 */
export function ReviewActions({ detail, showPrimary = true }: { detail: SessionDetail; showPrimary?: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const { openPanel } = useSessionUi();
  const [dialog, setDialog] = useState<Dialog>(null);
  const s = detail.session;
  const perms = actionPermissions(user, s);
  const terminal = s.state === "SUBMITTED" || s.state === "ABANDONED";
  const onSession = useSessionUpdate(s.id, () => setDialog(null));

  const resume = useMutation({
    mutationFn: () => api.resumeBriefing(s.id),
    onSuccess: onSession("Briefing resumed. Record what was missed, then end it again."),
    onError: (e) => toast.error(e, "Could not resume the briefing"),
  });

  const items: MenuItem[] = [
    { label: "Download PDF", icon: FileDown, onSelect: () => window.print() },
    { label: "How CrewBrief built this form", icon: Workflow, onSelect: () => openPanel("agents") },
    { label: "AI draft vs final", icon: GitCompare, onSelect: () => openPanel("diff") },
    { label: "Audit log", icon: History, onSelect: () => openPanel("audit") },
    ...(s.state === "REVIEW" && perms.resumeBriefing.allowed
      ? [{ label: "Resume briefing", icon: Play, onSelect: () => resume.mutate() }]
      : []),
    ...(!terminal && perms.abandon.allowed ? [{ label: "Abandon briefing…", icon: Ban, danger: true, onSelect: () => setDialog("abandon") }] : []),
  ];

  return (
    <div className="review-actions" role="group" aria-label="Briefing actions">
      <button type="button" className="btn btn-secondary" aria-label="Transcript" onClick={() => openPanel("transcript")}>
        <FileText size={16} aria-hidden="true" />
        <span className="hide-narrow">Transcript</span>
      </button>
      <Menu
        items={items}
        disabled={resume.isPending}
        trigger={
          <>
            {resume.isPending ? "Working…" : "More"}
            <ChevronDown size={16} aria-hidden="true" />
          </>
        }
      />
      {!showPrimary ? null : s.state === "SIGNED" ? (
        <ActionButton perm={perms.submit} primary onClick={() => setDialog("submit")}>
          Submit
        </ActionButton>
      ) : (
        !terminal && (
          <ActionButton perm={perms.signOff} primary onClick={() => setDialog("sign-off")}>
            Sign off
          </ActionButton>
        )
      )}

      {dialog === "sign-off" && <SignOffDialog detail={detail} onDone={onSession()} onClose={() => setDialog(null)} />}
      {dialog === "abandon" && <AbandonDialog session={s} onDone={onSession("Briefing abandoned")} onClose={() => setDialog(null)} />}
      {dialog === "submit" && <SubmitDialog session={s} onDone={onSession()} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Store a session returned by sign-off / submit / abandon and refresh the lists that show it. */
// eslint-disable-next-line react-refresh/only-export-components
export function useSessionUpdate(sessionId: string, after?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  // Sign-off and submit are announced by the live "Briefing is now …" notice, so they pass no label.
  return (label?: string) => (session: Session) => {
    qc.setQueryData<SessionDetail>(qk.session(sessionId), (d) => (d ? { ...d, session } : d));
    void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.sessions });
    if (label) toast.push("success", label);
    after?.();
  };
}

export function ActionButton({ perm, primary, onClick, children }: {
  perm: Permission;
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const hintId = useId();
  return (
    <span className="action">
      <button
        type="button"
        className={primary ? "btn btn-primary" : "btn btn-secondary"}
        aria-disabled={!perm.allowed}
        aria-describedby={perm.allowed ? undefined : hintId}
        onClick={() => perm.allowed && onClick()}
      >
        {children}
      </button>
      {!perm.allowed && (
        <span id={hintId} role="tooltip" className="hint">
          {perm.reason}
        </span>
      )}
    </span>
  );
}

export function SignOffDialog({ detail, onDone, onClose }: { detail: SessionDetail; onDone: (s: Session) => void; onClose: () => void }) {
  const toast = useToast();
  const openBlocking = detail.gaps
    .filter((g) => g.status === "open" && g.severity === "blocking")
    .map((g) => ({ key: g.id, message: g.message }));
  // The rules engine can still block (e.g. a dismissed gap whose rule still fails): it answers 409
  // `blocking_gaps` with the list, and the dialog switches to the override form.
  const [serverBlocking, setServerBlocking] = useState<{ key: string; message: string }[] | null>(null);
  const blocking = serverBlocking ?? openBlocking;
  const warnings = detail.gaps.filter((g) => g.status === "open" && g.severity === "warning").length;
  const [comment, setComment] = useState("");
  const [override, setOverride] = useState(false);
  const [justification, setJustification] = useState("");
  const needsOverride = blocking.length > 0;
  const valid = !needsOverride || (override && justification.trim().length >= MIN_JUSTIFICATION);

  const sign = useMutation({
    mutationFn: () =>
      api.signOff(detail.session.id, {
        comment: comment.trim() || null,
        override_blocking_gaps: needsOverride && override,
        override_justification: needsOverride && override ? justification.trim() : null,
      }),
    onSuccess: onDone,
    onError: (e) => {
      const list = e instanceof ApiError && e.code === "blocking_gaps" ? e.problem?.blocking : undefined;
      if (Array.isArray(list) && list.length) {
        setServerBlocking(
          list.map((b: { path?: string; message?: string }, i: number) => ({ key: `${b.path ?? i}`, message: b.message ?? "Blocking rule" })),
        );
        toast.push("warning", "Some safety rules still block sign-off", "Fix them, or override with a written reason.");
      } else {
        toast.error(e, "Sign-off was refused");
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) sign.mutate();
  };

  return (
    <Modal
      title="Sign off hazard assessment"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="sign-off" className="btn btn-primary" disabled={!valid || sign.isPending}>
            {sign.isPending ? "Signing…" : needsOverride ? "Override and sign off" : "Sign off"}
          </button>
        </>
      }
    >
      <form id="sign-off" className="stack" onSubmit={submit}>
        <p>
          You are confirming this form reflects the briefing and that controls are adequate for the job. The draft is at
          revision <strong>{detail.draft.revision}</strong>
          {warnings > 0 && <> with {warnings} open warning{warnings > 1 ? "s" : ""}</>}.
        </p>
        {needsOverride ? (
          <div className="callout callout-danger">
            <p>
              <strong>
                {blocking.length} blocking item{blocking.length > 1 ? "s" : ""}
              </strong>{" "}
              must be fixed, or overridden with a written reason. Overrides are audited.
            </p>
            <ul className="plain-list">
              {blocking.map((g) => (
                <li key={g.key}>
                  <GapSeverityBadge severity="blocking" /> {g.message}
                </li>
              ))}
            </ul>
            <label className="check">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Override blocking gaps
            </label>
            {override && (
              <label className="field">
                <span>Justification * (at least {MIN_JUSTIFICATION} characters)</span>
                <textarea rows={3} maxLength={2000} value={justification} onChange={(e) => setJustification(e.target.value)} required />
              </label>
            )}
          </div>
        ) : (
          <p className="callout callout-ok">No blocking items are open.</p>
        )}
        <label className="field">
          <span>Comment</span>
          <textarea rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

function AbandonDialog({ session, onDone, onClose }: { session: Session; onDone: (s: Session) => void; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const abandon = useMutation({
    mutationFn: () => api.abandon(session.id, { reason: reason.trim() }),
    onSuccess: onDone,
    onError: (e) => toast.error(e, "Could not abandon the briefing"),
  });
  return (
    <Modal
      title="Abandon briefing"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Keep briefing
          </button>
          <button type="submit" form="abandon" className="btn btn-danger" disabled={!reason.trim() || abandon.isPending}>
            Abandon
          </button>
        </>
      }
    >
      <form
        id="abandon"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) abandon.mutate();
        }}
      >
        <p>Abandoning closes “{session.title}” without submitting a form. This cannot be undone.</p>
        <label className="field">
          <span>Reason *</span>
          <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
        </label>
      </form>
    </Modal>
  );
}

export function SubmitDialog({ session, onDone, onClose }: { session: Session; onDone: (s: Session) => void; onClose: () => void }) {
  const toast = useToast();
  const submit = useMutation({
    mutationFn: () => api.submit(session.id),
    onSuccess: onDone,
    onError: (e) => toast.error(e, "Submission failed"),
  });
  return (
    <Modal
      title="Submit to safety system"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting…" : "Submit"}
          </button>
        </>
      }
    >
      <p>The signed form for “{session.title}” will be sent to the downstream safety system.</p>
    </Modal>
  );
}
