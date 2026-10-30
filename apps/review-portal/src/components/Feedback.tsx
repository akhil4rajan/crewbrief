import { CircleAlert, Info, OctagonAlert, RotateCcw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { GapSeverity, SessionState, Severity } from "../api/types";
import { GAP_SEVERITY_LABEL, SEVERITY_LABEL, STATE_LABEL } from "../format";

/** Status as a small coloured dot and plain text: calmer than a filled pill. */
export function StateBadge({ state }: { state: SessionState }) {
  return (
    <span className={`status state-${state.toLowerCase()}`}>
      <span className="dot" aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`status sev-${severity}`}>
      <span className="dot" aria-hidden="true" />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

const GAP_ICON: Record<GapSeverity, LucideIcon> = { blocking: OctagonAlert, warning: CircleAlert, info: Info };

export function GapSeverityBadge({ severity, iconOnly }: { severity: GapSeverity; iconOnly?: boolean }) {
  const Icon = GAP_ICON[severity];
  return (
    <span className={`status gap-${severity}`}>
      <Icon size={16} aria-hidden="true" />
      <span className={iconOnly ? "sr-only" : undefined}>{GAP_SEVERITY_LABEL[severity]}</span>
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
        <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
}
