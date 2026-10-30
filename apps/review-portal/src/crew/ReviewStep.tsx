import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { AuditTab } from "../session/AuditTab";
import { DecisionsSection } from "../session/Decisions";
import { DiffTab } from "../session/DiffTab";
import { isLead } from "../session/permissions";
import { CrewSection, HazardsSection, JobSection } from "../session/ReviewSections";
import { SessionProvider, useSessionUi } from "../session/SessionContext";
import { TranscriptPane } from "../session/TranscriptPane";

interface Props {
  detail: SessionDetail;
  segments: TranscriptSegment[];
  transcriptLoading: boolean;
}

/**
 * Step 3, Review & submit: one column, top to bottom. The crew lead settles open gaps, checks
 * hazards and the job details, names the voices, then signs off and submits. Everyone else on
 * the crew sees the same page read-only and confirms they've read it.
 */
export function ReviewStep({ detail, segments, transcriptLoading }: Props) {
  return (
    <SessionProvider detail={detail} segments={segments}>
      <ReviewHeader detail={detail} />
      <div className="review-col">
        <StatusNote detail={detail} />
        <ErrorBoundary label="This section failed to render">
          <DecisionsSection />
        </ErrorBoundary>
        <ErrorBoundary label="Hazards failed to render">
          <HazardsSection />
        </ErrorBoundary>
        <ErrorBoundary label="Job details failed to render">
          <JobSection />
        </ErrorBoundary>
        <ErrorBoundary label="Crew failed to render">
          <CrewSection />
        </ErrorBoundary>
        <Acknowledge detail={detail} />
      </div>
      <Panels sessionId={detail.session.id} transcriptLoading={transcriptLoading} />
    </SessionProvider>
  );
}

function ReviewHeader({ detail }: { detail: SessionDetail }) {
  const { user } = useAuth();
  const { openPanel } = useSessionUi();
  const lead = isLead(user, detail.session);
  return (
    <header className="review-bar">
      <div className="review-bar-title">
        <h1>{detail.session.title}</h1>
        <StateBadge state={detail.session.state} />
      </div>
      {lead ? (
        <ReviewActions detail={detail} />
      ) : (
        <button type="button" className="btn" onClick={() => openPanel("transcript")}>
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
  const blocking = detail.gaps.filter((g) => g.status === "open" && g.severity === "blocking").length;

  let text: string;
  if (s.state === "REVIEW") {
    text = lead
      ? blocking
        ? `Settle the ${blocking} blocking item${blocking > 1 ? "s" : ""} below, check the hazards, then sign off.`
        : "Check the hazards and job details, then sign off."
      : `${leadName} is reviewing this form. Read it, then confirm at the bottom.`;
  } else if (s.state === "SIGNED") {
    text = `Signed off by ${users.get(s.signed_by ?? "")?.name ?? "the crew lead"} on ${formatDateTime(s.signed_at)}.${lead ? " Submit it to send it to the safety system." : ""}`;
  } else {
    text = `Submitted${s.submission_ref ? ` as ${s.submission_ref}` : ""} on ${formatDateTime(s.submitted_at)}. Nothing more to do.`;
  }
  return (
    <p className={`status-note status-note-${s.state.toLowerCase()}`} role="status">
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
  if (!onJob) return null;
  return (
    <section className="review-section ack-section" aria-label="Confirm you've read the form">
      {me?.acknowledged ? (
        <p className="ok-text">✓ You've confirmed you read the form.</p>
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

const PANEL_TITLE = { transcript: "Transcript", audit: "Audit log", diff: "AI draft vs final" } as const;

function Panels({ sessionId, transcriptLoading }: { sessionId: string; transcriptLoading: boolean }) {
  const { panel, closePanel } = useSessionUi();
  if (!panel) return null;
  return (
    <Drawer title={PANEL_TITLE[panel]} onClose={closePanel}>
      <ErrorBoundary label="This panel failed to render">
        {panel === "transcript" && <TranscriptPane loading={transcriptLoading} />}
        {panel === "audit" && <AuditTab sessionId={sessionId} />}
        {panel === "diff" && <DiffTab sessionId={sessionId} />}
      </ErrorBoundary>
    </Drawer>
  );
}
