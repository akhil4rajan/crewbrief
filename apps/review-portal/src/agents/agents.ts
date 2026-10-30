import { AudioLines, ClipboardPen, MessageCircleQuestion, ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import type { AgentRole, AgentStep } from "../api/types";

export interface AgentInfo {
  name: string;
  icon: LucideIcon;
  /** What the agent does, in one short line. */
  job: string;
}

export const AGENTS: Record<AgentRole, AgentInfo> = {
  "conversation-analyst": { name: "Analyst", icon: AudioLines, job: "Reads the conversation and picks out what matters" },
  "hazard-expert": { name: "Hazard expert", icon: ShieldAlert, job: "Matches what was said to the hazard library" },
  "form-filler": { name: "Form filler", icon: ClipboardPen, job: "Turns findings into changes to the form" },
  verifier: { name: "Verifier", icon: ShieldCheck, job: "Checks the form for anything missing" },
  "voice-prompter": { name: "Question writer", icon: MessageCircleQuestion, job: "Words the closing questions for the crew" },
};

/** The pipeline shown while recording, in run order. */
export const PIPELINE: AgentRole[] = ["conversation-analyst", "hazard-expert", "form-filler", "verifier"];

export const STEP_LABEL: Record<AgentStep, string> = {
  live: "During the briefing",
  final: "Final pass",
  answers: "Clarifying answers",
  verify: "Verification",
  clarify: "Closing questions",
};

export function agentInfo(role: string): AgentInfo {
  return AGENTS[role as AgentRole] ?? { name: role, icon: ShieldCheck, job: "" };
}

/** "Azure OpenAI · gpt-4o-mini" or "Rule-based (offline)". */
export function providerLabel(provider: string | null | undefined, model: string | null | undefined): string {
  if (provider === "azure-openai") return `Azure OpenAI · ${model || "model"}`;
  if (provider === "heuristic-fallback") return "Rule-based (fallback)";
  if (provider === "heuristic") return "Rule-based (offline)";
  if (model && /heuristic|rule/i.test(model)) return "Rule-based (offline)";
  return model || "Unknown model";
}

export function isLlm(provider: string | null | undefined): boolean {
  return provider === "azure-openai";
}
