import { ArrowLeft, ArrowRight, CircleCheck, OctagonAlert, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Gap, GapKind, GapSeverity, HazardStatus, SessionDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { formatOffset } from "../format";
import { sectionFor, useEditors } from "../session/Editors";
import { actionPermissions } from "../session/permissions";
import { RiskChip } from "../session/Risk";
import { useSessionUi } from "../session/SessionContext";

// ---------------------------------------------------------------- the queue

const RANK: Record<GapSeverity, number> = { blocking: 0, warning: 1, info: 2 };
const isOpen = (g: Gap | undefined) => !!g && g.status === "open";

/** The hazard a gap is about, from its path (`/hazards/<code>/...`). */
function hazardCode(path: string): string | null {
  const parts = path.split("/");
  return parts[1] === "hazards" && parts[2] ? parts[2].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

export interface CheckQueue {
  ids: string[];
  index: number;
  /** Open items that still need a decision. */
  remaining: number;
  setIndex: (i: number) => void;
  /** Mark the current item decided (before the server's gap update lands). */
  markDecided: (id: string) => void;
  /** Index of the next item after `from` that still needs a decision, or -1. */
  nextOpen: (from: number) => number;
  /** Start over from the first undecided item (or the first item if all are settled). */
  restart: () => void;
  isSettled: (g: Gap | undefined) => boolean;
}

/**
 * The crew lead's decisions, one at a time: blocking items first (highest risk first), then the
 * optional ones. Items that appear while deciding (e.g. "add a control" after confirming a hazard)
 * slot in next if they block sign-off, or at the end if they don't.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useCheckQueue(detail: SessionDetail): CheckQueue {
  const gaps = detail.gaps;
  const risk = detail.risk;
  const byId = useMemo(() => new Map(gaps.map((g) => [g.id, g])), [gaps]);
  const order = useCallback(
    (list: Gap[]) => {
      const score = (g: Gap) => {
        const code = hazardCode(g.path);
        return code ? (risk?.[code]?.before.score ?? 0) : 0;
      };
      return [...list].sort((a, b) => RANK[a.severity] - RANK[b.severity] || score(b) - score(a) || a.path.localeCompare(b.path));
    },
    [risk],
  );
  const [ids, setIds] = useState<string[]>(() => order(gaps.filter(isOpen)).map((g) => g.id));
  const [index, setIndex] = useState(0);
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());

  // New open items join the queue.
  useEffect(() => {
    const fresh = order(gaps.filter((g) => isOpen(g) && !ids.includes(g.id)));
    if (!fresh.length) return;
    const blocking = fresh.filter((g) => g.severity === "blocking").map((g) => g.id);
    const rest = fresh.filter((g) => g.severity !== "blocking").map((g) => g.id);
    setIds((prev) => {
      const at = Math.min(index + 1, prev.length);
      return [...prev.slice(0, at), ...blocking, ...prev.slice(at), ...rest];
    });
  }, [gaps, ids, index, order]);

  const isSettled = useCallback((g: Gap | undefined) => !isOpen(g) || decided.has(g!.id), [decided]);
  const nextOpen = useCallback(
    (from: number) => {
      for (let i = from + 1; i < ids.length; i++) if (!isSettled(byId.get(ids[i]))) return i;
      return -1;
    },
    [ids, byId, isSettled],
  );
  const markDecided = useCallback((id: string) => setDecided((prev) => new Set(prev).add(id)), []);
  const restart = useCallback(() => {
    const first = ids.findIndex((id) => !isSettled(byId.get(id)));
    setIndex(first === -1 ? 0 : first);
  }, [ids, byId, isSettled]);
  const remaining = gaps.filter((g) => isOpen(g) && !decided.has(g.id)).length;

  return { ids, index, remaining, setIndex, markDecided, nextOpen, restart, isSettled };
}

// ---------------------------------------------------------------- the screen

const PLAIN: Partial<Record<GapKind, string>> = {
  unconfirmed_hazard: "typical for this job but not discussed",
  high_risk_without_control: "high risk, and no strong control was stated",
  hazard_without_control: "discussed, but no control was stated",
  contradiction: "the crew said different things about it",
  low_confidence: "only hinted at in the briefing",
  unsupported_field: "nothing in the briefing backs this up",
};

const WHY: Record<GapKind, string> = {
  unconfirmed_hazard: "Jobs like this usually involve this hazard, but nobody mentioned it. Confirm it applies today, or rule it out.",
  high_risk_without_control: "High-risk hazards need an isolation or engineering control on the form before it can be signed.",
  hazard_without_control: "Every hazard on the form needs at least one control the crew will use.",
  contradiction: "Different things were said about this in the briefing. Check which is right.",
  missing_required_field: "The company form needs this before it can be signed.",
  low_confidence: "CrewBrief isn't sure this was really discussed. Check it is right, or dismiss it.",
  unsupported_field: "Everything on the form should come from what the crew said.",
};

/**
 * Check: the items CrewBrief wants a person to decide, one large card at a time. Each decision
 * moves on to the next item; when nothing is left the review moves on to Sign.
 */
export function CheckStep({ queue, onFinish }: { queue: CheckQueue; onFinish: () => void }) {
  const { detail } = useSessionUi();
  const { ids, index, setIndex, nextOpen } = queue;
  const byId = new Map(detail.gaps.map((g) => [g.id, g]));
  const settledCount = ids.filter((id) => queue.isSettled(byId.get(id))).length;
  const blockingLeft = ids.filter((id) => byId.get(id)?.severity === "blocking" && !queue.isSettled(byId.get(id))).length;
  const gap = byId.get(ids[index]);

  const advance = useCallback(() => {
    const next = nextOpen(index);
    if (next === -1) onFinish();
    else setIndex(next);
  }, [nextOpen, index, onFinish, setIndex]);

  if (!ids.length || !gap) {
    return (
      <section className="check-empty" aria-label="Check">
        <CircleCheck size={32} aria-hidden="true" />
        <h2>Nothing to decide</h2>
        <p className="muted">CrewBrief didn't flag anything on this form.</p>
        <button type="button" className="btn btn-primary btn-large" onClick={onFinish}>
          Go to Sign
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </section>
    );
  }

  const optional = gap.severity !== "blocking";
  const pct = Math.round((settledCount / ids.length) * 100);
  return (
    <section className="check-step" aria-label="Check the flagged items">
      <div className="check-progress">
        <div className="check-progress-text">
          <span className="check-count">
            {index + 1} of {ids.length}
          </span>
          <span className="muted small">
            {settledCount} decided
            {blockingLeft > 0 && ` · ${blockingLeft} still ${blockingLeft === 1 ? "blocks" : "block"} sign-off`}
          </span>
        </div>
        <div className="check-bar" role="progressbar" aria-valuemin={0} aria-valuemax={ids.length} aria-valuenow={settledCount} aria-label="Items decided">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      <DecisionCard key={gap.id} gap={gap} optional={optional} settled={queue.isSettled(gap)} onDecided={advance} markDecided={queue.markDecided} />

      <nav className="check-nav" aria-label="Move between items">
        <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        <span className="check-nav-end">
          {optional && (
            <button type="button" className="btn btn-ghost" onClick={onFinish}>
              Skip optional items
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => (index + 1 < ids.length ? setIndex(index + 1) : onFinish())}
          >
            {queue.isSettled(gap) ? "Next" : "Skip"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </span>
      </nav>
    </section>
  );
}

function DecisionCard({ gap, optional, settled, onDecided, markDecided }: {
  gap: Gap;
  optional: boolean;
  settled: boolean;
  onDecided: () => void;
  markDecided: (id: string) => void;
}) {
  const { detail, edit, applyEdit, editing, humanProvenance, speakerName, highlightSegment } = useSessionUi();
  const { user } = useAuth();
  const { openHazard, openSection, requestDismiss, busy } = useEditors();
  const code = hazardCode(gap.path);
  const hazard = code ? detail.draft.form.hazards[code] : undefined;
  const risk = code ? detail.risk?.[code] : undefined;
  const section = sectionFor(gap.path);
  const canDismiss = actionPermissions(user, detail.session).dismissGap.allowed;
  const quotes = (hazard?.provenance.evidence ?? []).filter((e) => e.segment_id && e.quote).slice(0, 3);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headRef.current?.focus({ preventScroll: true }), []);

  // Settled elsewhere (a control added in the panel, a dismissal): move on once the panel closes.
  const wasOpen = useRef(!settled);
  useEffect(() => {
    if (!wasOpen.current || !settled || busy) return;
    const t = window.setTimeout(() => {
      wasOpen.current = false;
      onDecided();
    }, 400);
    return () => window.clearTimeout(t);
  }, [settled, busy, onDecided]);

  const decide = async (status: HazardStatus) => {
    if (!hazard) return;
    const base = `/hazards/${gap.path.split("/")[2]}`;
    const ok = await applyEdit([
      { op: "replace", path: `${base}/status`, value: status, provenance: humanProvenance() },
      { op: "replace", path: `${base}/provenance`, value: humanProvenance(hazard.provenance), provenance: humanProvenance() },
    ]);
    if (ok) {
      wasOpen.current = false;
      markDecided(gap.id);
      onDecided();
    }
  };

  const title = hazard?.name ?? gap.message;
  const plain = hazard ? PLAIN[gap.kind] : undefined;
  const Icon = optional ? CircleCheck : OctagonAlert;

  return (
    <article className={`check-card${optional ? " is-optional" : " is-blocking"}`} aria-live="polite">
      <p className="check-kicker">
        {optional ? (
          <span className="check-tag check-tag-optional">Optional</span>
        ) : (
          <span className="check-tag check-tag-blocking">
            <Icon size={14} aria-hidden="true" />
            Decide before signing
          </span>
        )}
      </p>
      <h2 className="check-title" ref={headRef} tabIndex={-1}>
        {title}
        {plain && <span className="check-plain"> — {plain}</span>}
      </h2>
      {risk && (
        <p className="check-risk">
          <span className="muted small">Risk before controls</span>
          <RiskChip risk={risk.before} />
        </p>
      )}
      <div className="check-why">
        <h3>Why CrewBrief is asking</h3>
        <p>{WHY[gap.kind]}</p>
      </div>
      {quotes.length > 0 && (
        <div className="check-quotes">
          <h3>What was said</h3>
          <ul>
            {quotes.map((q, i) => (
              <li key={`${q.segment_id}-${i}`}>
                <button type="button" className="quote" onClick={() => highlightSegment(q.segment_id)}>
                  <span className="quote-text">“{q.quote}”</span>
                  <span className="quote-meta">
                    {speakerName(q.speaker_id)} · {formatOffset(q.start_ms)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {settled ? (
        <div className="check-settled" role="status">
          <CircleCheck size={20} aria-hidden="true" />
          <span>
            Decided
            {gap.status === "dismissed" && gap.resolution ? `: dismissed, “${gap.resolution}”` : hazard ? `: ${hazardOutcome(hazard.status)}` : ""}
          </span>
          {hazard && edit.allowed && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => openHazard(hazard.code)}>
              Change
            </button>
          )}
        </div>
      ) : (
        <div className="check-actions">
          {gap.kind === "unconfirmed_hazard" && hazard && edit.allowed && (
            <>
              <button type="button" className="btn btn-secondary btn-xl" disabled={editing} onClick={() => void decide("not_present")}>
                Not applicable
              </button>
              <button type="button" className="btn btn-primary btn-xl" disabled={editing} onClick={() => void decide("present")}>
                Confirm present
              </button>
            </>
          )}
          {(gap.kind === "high_risk_without_control" || gap.kind === "hazard_without_control") && hazard && edit.allowed && (
            <button type="button" className="btn btn-primary btn-xl" onClick={() => openHazard(hazard.code)}>
              <Plus size={18} aria-hidden="true" />
              Add a control
            </button>
          )}
          {!hazard && section && edit.allowed && (
            <button type="button" className="btn btn-primary btn-xl" onClick={() => openSection(section)}>
              Fill it in
            </button>
          )}
          {gap.kind !== "unconfirmed_hazard" && canDismiss && (
            <button type="button" className="btn btn-secondary btn-xl" onClick={() => requestDismiss(gap)}>
              Dismiss with reason
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function hazardOutcome(status: HazardStatus): string {
  if (status === "not_present") return "not applicable";
  if (status === "present") return "confirmed present";
  return "kept on the form";
}
