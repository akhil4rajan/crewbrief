import type { GapSeverity, SessionState, Severity } from "@/api/types";

/**
 * High-contrast palette for use outdoors in sunlight and with gloves on: near-black text on
 * white, saturated status colours, large type and touch targets (≥ 64 px for primary actions).
 */
export const colors = {
  bg: "#FFFFFF",
  surface: "#F2F4F7",
  border: "#8A94A6",
  text: "#0A0A0A",
  textMuted: "#3D4554",
  primary: "#0047AB",
  primaryText: "#FFFFFF",
  danger: "#B3001B",
  dangerBg: "#FDE7EA",
  warning: "#8A5A00",
  warningBg: "#FFF3D6",
  success: "#0B6B2E",
  successBg: "#E3F6EA",
  info: "#0047AB",
  infoBg: "#E6EEFA",
  recording: "#D7001F",
  focus: "#FFB000",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export const font = {
  small: 15,
  body: 18,
  large: 22,
  title: 28,
  huge: 34,
} as const;

/** Minimum heights for touch targets. */
export const touch = { min: 56, primary: 72, record: 120 } as const;

export const severityColor: Record<Severity, { fg: string; bg: string; label: string }> = {
  critical: { fg: "#FFFFFF", bg: "#8B0000", label: "CRITICAL" },
  high: { fg: "#FFFFFF", bg: "#D7001F", label: "HIGH" },
  medium: { fg: "#000000", bg: "#FFB000", label: "MEDIUM" },
  low: { fg: "#FFFFFF", bg: "#0B6B2E", label: "LOW" },
};

export const gapSeverityColor: Record<GapSeverity, { fg: string; bg: string }> = {
  blocking: { fg: colors.danger, bg: colors.dangerBg },
  warning: { fg: colors.warning, bg: colors.warningBg },
  info: { fg: colors.info, bg: colors.infoBg },
};

export const stateLabel: Record<SessionState, string> = {
  CREATED: "Not started",
  BRIEFING: "Briefing",
  DRAFTING: "Briefing",
  GAP_CHECK: "Checking gaps",
  REVIEW: "With supervisor",
  SIGNED: "Signed",
  SUBMITTED: "Submitted",
  ABANDONED: "Abandoned",
};
