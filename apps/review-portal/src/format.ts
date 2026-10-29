import type { GapSeverity, SessionState, Severity } from "./api/types";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatTime(iso: string | null | undefined): string {
  return iso ? timeFmt.format(new Date(iso)) : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : "—";
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}

/** Briefing offset in mm:ss (transcript timestamps are ms from the start of the briefing). */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export const STATE_LABEL: Record<SessionState, string> = {
  CREATED: "Created",
  BRIEFING: "Briefing",
  DRAFTING: "Drafting",
  GAP_CHECK: "Gap check",
  REVIEW: "Needs review",
  SIGNED: "Signed",
  SUBMITTED: "Submitted",
  ABANDONED: "Abandoned",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const GAP_SEVERITY_LABEL: Record<GapSeverity, string> = {
  blocking: "Blocking",
  warning: "Warning",
  info: "Info",
};

export function humanize(code: string): string {
  const s = code.replace(/[_.]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function slugify(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
