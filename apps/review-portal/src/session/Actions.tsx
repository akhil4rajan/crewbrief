import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { Session, SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { GapSeverityBadge } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { actionPermissions, type Permission } from "./permissions";

type Dialog = "sign-off" | "abandon" | "submit" | null;

const MIN_JUSTIFICATION = 10;

/** State-dependent session actions. Disabled actions stay visible and say why. */
export function SessionActions({ detail }: { detail: SessionDetail }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const s = detail.session;
  const perms = actionPermissions(user, s);

  const onSession = (label: string) => (session: Session) => {
    qc.setQueryData<SessionDetail>(qk.session(s.id), (d) => (d ? { ...d, session } : d));
    void qc.invalidateQueries({ queryKey: qk.session(s.id) });
    void qc.invalidateQueries({ queryKey: qk.sessions });
    toast.push("success", label);
    setDialog(null);
  };

  const end = useMutation({
    mutationFn: () => api.endBriefing(s.id),
    onSuccess: onSession("Briefing ended — final checks are running"),
    onError: (e) => toast.error(e, "Could not end the briefing"),
  });
  const resume = useMutation({
    mutationFn: () => api.resumeBriefing(s.id),
    onSuccess: onSession("Briefing resumed"),
    onError: (e) => toast.error(e, "Could not resume the briefing"),
  });

  const terminal = s.state === "SUBMITTED" || s.state === "ABANDONED";
  return (
    <div className="actions" role="group" aria-label="Session actions">
      {!terminal && s.state !== "REVIEW" && s.state !== "SIGNED" && (
        <ActionButton perm={perms.endBriefing} busy={end.isPending} onClick={() => end.mutate()}>
          End briefing
        </ActionButton>
      )}
      {s.state === "REVIEW" && (
        <ActionButton perm={perms.resumeBriefing} busy={resume.isPending} onClick={() => resume.mutate()}>
          Resume briefing
        </ActionButton>
      )}
      {!terminal && s.state !== "SIGNED" && (
        <ActionButton perm={perms.signOff} primary onClick={() => setDialog("sign-off")}>
          Sign off
        </ActionButton>
      )}
      {s.state === "SIGNED" && (
        <ActionButton perm={perms.submit} primary onClick={() => setDialog("submit")}>
          Submit
        </ActionButton>
      )}
      {!terminal && (
        <ActionButton perm={perms.abandon} danger onClick={() => setDialog("abandon")}>
          Abandon
        </ActionButton>
      )}

      {dialog === "sign-off" && <SignOffDialog detail={detail} onDone={onSession("Form signed off")} onClose={() => setDialog(null)} />}
      {dialog === "abandon" && <AbandonDialog session={s} onDone={onSession("Session abandoned")} onClose={() => setDialog(null)} />}
      {dialog === "submit" && <SubmitDialog session={s} onDone={onSession("Form submitted")} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ActionButton({ perm, busy, primary, danger, onClick, children }: {
  perm: Permission;
  busy?: boolean;
  primary?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const hintId = useId();
  const cls = ["btn", primary && "btn-primary", danger && "btn-danger"].filter(Boolean).join(" ");
  return (
    <span className="action">
      <button
        type="button"
        className={cls}
        aria-disabled={!perm.allowed || busy}
        aria-describedby={perm.allowed ? undefined : hintId}
        onClick={() => perm.allowed && !busy && onClick()}
      >
        {busy ? "Working…" : children}
      </button>
      {!perm.allowed && (
        <span id={hintId} role="tooltip" className="hint">
          {perm.reason}
        </span>
      )}
    </span>
  );
}

function SignOffDialog({ detail, onDone, onClose }: { detail: SessionDetail; onDone: (s: Session) => void; onClose: () => void }) {
  const toast = useToast();
  const blocking = detail.gaps.filter((g) => g.status === "open" && g.severity === "blocking");
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
    onError: (e) => toast.error(e, "Sign-off was refused"),
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
              <strong>{blocking.length} blocking gap{blocking.length > 1 ? "s" : ""}</strong> must be fixed, or overridden with a written
              justification (audited).
            </p>
            <ul className="plain-list">
              {blocking.map((g) => (
                <li key={g.id}>
                  <GapSeverityBadge severity={g.severity} /> {g.message}
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
          <p className="callout callout-ok">No blocking gaps are open.</p>
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
    onError: (e) => toast.error(e, "Could not abandon the session"),
  });
  return (
    <Modal
      title="Abandon session"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Keep session
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

function SubmitDialog({ session, onDone, onClose }: { session: Session; onDone: (s: Session) => void; onClose: () => void }) {
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
