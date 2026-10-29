import type { ReactNode } from "react";
import type { GapSeverity, SessionState, Severity } from "../api/types";
import { GAP_SEVERITY_LABEL, SEVERITY_LABEL, STATE_LABEL } from "../format";

export function StateBadge({ state }: { state: SessionState }) {
  return <span className={`badge state-${state.toLowerCase()}`}>{STATE_LABEL[state]}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

const GAP_ICON: Record<GapSeverity, string> = { blocking: "⛔", warning: "⚠", info: "ℹ" };

export function GapSeverityBadge({ severity }: { severity: GapSeverity }) {
  return (
    <span className={`badge gap-${severity}`}>
      <span aria-hidden="true">{GAP_ICON[severity]}</span> {GAP_SEVERITY_LABEL[severity]}
    </span>
  );
}

export function Skeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: height ?? 14, width: `${90 - (i % 3) * 18}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function InlineError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <span>{error instanceof Error ? error.message : "Failed to load"}</span>
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
