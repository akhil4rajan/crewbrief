import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, FileText } from "lucide-react";
import { useState } from "react";
import { api } from "../api/endpoints";
import { qk, useUserDirectory } from "../api/queries";
import type { SessionDetail, TranscriptSegment } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Drawer } from "../components/Drawer";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { StateBadge } from "../components/Feedback";
import { useToast } from "../components/Toasts";
import { formatDateTime } from "../format";
import { ReviewActions } from "../session/Actions";
import { AgentTimeline } from "../session/AgentTimeline";
import { AuditTab } from "../session/AuditTab";
import { DiffTab } from "../session/DiffTab";
import { isLead } from "../session/permissions";
import { EditorsProvider } from "../session/Editors";
import { JseaDocument } from "../session/JseaForm";
import { SessionProvider, useSessionUi } from "../session/SessionContext";
import { TranscriptPane } from "../session/TranscriptPane";
import { CheckStep, useCheckQueue } from "./CheckStep";

interface Props {
  detail: SessionDetail;
  segments: TranscriptSegment[];
  transcriptLoading: boolean;
}

/**
 * Step 3, Review & submit, in two parts like checking a paper form. Check: the crew lead settles
 * CrewBrief's flagged items one card at a time. Sign: the finished JSEA, read-only, with the
 * declaration to sign and then submit. Everyone else on the crew sees the Sign view and confirms
 * they've read it.
 */
export function ReviewStep({ detail, segments, transcriptLoading }: Props) {
  return (
    <SessionProvider detail={detail} segments={segments}>
      <EditorsProvider>
        <Review detail={detail} />
      </EditorsProvider>
      <Panels sessionId={detail.session.id} transcriptLoading={transcriptLoading} />
    </SessionProvider>
  );
}

type View = "check" | "sign";

function Review({ detail }: { detail: SessionDetail }) {
  const { user } = useAuth();
  const queue = useCheckQueue(detail);
  const reviewing = detail.session.state === "REVIEW" && isLead(user, detail.session);
  const [view, setView] = useState<View>(() => (queue.remaining > 0 ? "check" : "sign"));
  const shown: View = reviewing ? view : "sign";

  const go = (next: View) => {
    if (next === "check") queue.restart();
    setView(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <ReviewHeader detail={detail} signing={shown === "sign"} />
      <div className="review-col">
        {reviewing && queue.ids.length > 0 && <SubSteps view={shown} remaining={queue.remaining} onGo={go} />}
        {shown === "check" ? (
          <ErrorBoundary label="The check failed to render">
            <CheckStep queue={queue} onFinish={() => go("sign")} />
          </ErrorBoundary>
        ) : (
          <>
            <StatusNote detail={detail} />
            {reviewing && <BlockingNote detail={detail} onCheck={() => go("check")} />}
            <ErrorBoundary label="The form failed to render">
              <JseaDocument />
            </ErrorBoundary>
            <Acknowledge detail={detail} />
          </>
        )}
      </div>
    </>
  );
}

/** "Check (n) → Sign": where the crew lead is inside step 3. */
function SubSteps({ view, remaining, onGo }: { view: View; remaining: number; onGo: (v: View) => void }) {
  return (
    <nav className="substeps no-print" aria-label="Review steps">
      <ol>
        <li>
          <button
            type="button"
            className={`substep${view === "check" ? " is-current" : ""}${remaining === 0 ? " is-done" : ""}`}
            aria-current={view === "check" ? "step" : undefined}
            onClick={() => onGo("check")}
          >
            {remaining === 0 ? <CircleCheck size={16} aria-hidden="true" /> : <span className="substep-count">{remaining}</span>}
            Check
          </button>
        </li>
        <li aria-hidden="true" className="substep-sep">
          <ChevronRight size={16} />
        </li>
        <li>
          <button
            type="button"
            className={`substep${view === "sign" ? " is-current" : ""}`}
            aria-current={view === "sign" ? "step" : undefined}
            onClick={() => onGo("sign")}
          >
            Sign
          </button>
        </li>
      </ol>
      {view === "sign" && (
        <button type="button" className="link-btn" onClick={() => onGo("check")}>
          Review decisions again
        </button>
      )}
    </nav>
  );
}

/** On the Sign view: items that still block sign-off, with a way back to Check. */
function BlockingNote({ detail, onCheck }: { detail: SessionDetail; onCheck: () => void }) {
  const n = detail.gaps.filter((g) => g.status === "open" && g.severity === "blocking").length;
  if (!n) return null;
  return (
    <p className="status-note status-note-attn no-print" role="status">
      <span>
        {n} {n === 1 ? "item still needs" : "items still need"} a decision before you can sign off.
      </span>
      <button type="button" className="btn btn-secondary btn-small" onClick={onCheck}>
        Go to Check
      </button>
    </p>
  );
}

function ReviewHeader({ detail, signing }: { detail: SessionDetail; signing: boolean }) {
  const { user } = useAuth();
  const { openPanel } = useSessionUi();
  const lead = isLead(user, detail.session);
  return (
    <header className="review-bar no-print">
      <div className="review-bar-title">
        <h1>{detail.session.title}</h1>
        <StateBadge state={detail.session.state} />
      </div>
      {lead ? (
        <ReviewActions detail={detail} showPrimary={signing} />
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => openPanel("transcript")}>
          <FileText size={16} aria-hidden="true" />
          Transcript
        </button>
      )}
    </header>
  );
}

function StatusNote({ detail }: { detail: SessionDetail }) {
  const { user } = useAuth();
  const users = useUserDirectory();
  const s = detail.session;
  const lead = isLead(user, s);
  const leadName = users.get(s.created_by)?.name ?? "The crew lead";

  if (s.state === "REVIEW" && lead) return null; // the sub-steps and the declaration say what's next
  let text: string;
  if (s.state === "REVIEW") {
    text = `${leadName} is reviewing this form. Read it, then confirm at the bottom.`;
  } else if (s.state === "SIGNED") {
    text = `Signed off by ${users.get(s.signed_by ?? "")?.name ?? "the crew lead"} on ${formatDateTime(s.signed_at)}.${lead ? " Submit it to send it to the safety system." : ""}`;
  } else {
    text = `Submitted${s.submission_ref ? ` as ${s.submission_ref}` : ""} on ${formatDateTime(s.submitted_at)}.`;
  }
  return (
    <p className={`status-note status-note-${s.state.toLowerCase()} no-print`} role="status">
      {text}
    </p>
  );
}

function Acknowledge({ detail }: { detail: SessionDetail }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const s = detail.session;
  const me = user ? detail.draft.form.crew[user.id] : undefined;
  const onJob = !!user && (s.created_by === user.id || s.crew_member_ids.includes(user.id) || !!me);
  const ack = useMutation({
    mutationFn: () => api.acknowledge(s.id),
    onSuccess: (d) => {
      qc.setQueryData(qk.session(s.id), d);
      toast.push("success", "Thanks, you've confirmed you read the form");
    },
    onError: (err) => toast.error(err, "Could not record that you read the form"),
  });
  // The crew lead confirms by signing the declaration; this is for everyone else on the job.
  if (!onJob || isLead(user, s)) return null;
  return (
    <section className="review-section ack-section no-print" aria-label="Confirm you've read the form">
      {me?.acknowledged ? (
        <p className="all-clear">
          <CircleCheck size={20} aria-hidden="true" />
          You've confirmed you read the form.
        </p>
      ) : (
        <>
          <p>Everyone on the job should read the form before work starts.</p>
          <button type="button" className="btn btn-primary btn-large btn-block" onClick={() => ack.mutate()} disabled={ack.isPending}>
            {ack.isPending ? "Saving…" : "I've read the form"}
          </button>
        </>
      )}
    </section>
  );
}

const PANEL_TITLE = {
  transcript: "Transcript",
  audit: "Audit log",
  diff: "AI draft vs final",
  agents: "How CrewBrief built this form",
} as const;

function Panels({ sessionId, transcriptLoading }: { sessionId: string; transcriptLoading: boolean }) {
  const { panel, closePanel } = useSessionUi();
  if (!panel) return null;
  return (
    <Drawer title={PANEL_TITLE[panel]} onClose={closePanel}>
      <ErrorBoundary label="This panel failed to render">
        {panel === "transcript" && <TranscriptPane loading={transcriptLoading} />}
        {panel === "audit" && <AuditTab sessionId={sessionId} />}
        {panel === "diff" && <DiffTab sessionId={sessionId} />}
        {panel === "agents" && <AgentTimeline sessionId={sessionId} />}
      </ErrorBoundary>
    </Drawer>
  );
}
