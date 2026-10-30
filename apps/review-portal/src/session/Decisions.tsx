import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { Gap, SessionDetail } from "../api/types";
import { GapSeverityBadge } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";

/** Dismiss an open gap with a written reason (kept in the audit log). */
export function DismissDialog({ gap, sessionId, onClose }: { gap: Gap; sessionId: string; onClose: () => void }) {
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
