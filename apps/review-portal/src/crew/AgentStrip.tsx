import { ChevronRight, Sparkles } from "lucide-react";
import { Fragment } from "react";
import { PIPELINE, agentInfo } from "../agents/agents";
import type { AgentRole } from "../api/types";
import type { ReceivedActivity } from "../realtime/useSessionLive";

/** A `started` with no answer after this long is treated as finished (the done event was lost). */
const STALE_MS = 45_000;

interface Props {
  activity: ReceivedActivity[];
  /** Copy for before the first agent has run. */
  idle?: string;
}

/**
 * "AI at work": the agent pipeline with the running agent highlighted and the latest finished
 * agent's one-line summary. Driven by `agent.activity` events from the live socket.
 */
export function AgentStrip({ activity, idle = "Agents start once the first lines are heard." }: Props) {
  const last = new Map<string, ReceivedActivity>();
  for (const a of activity) last.set(a.role, a);
  const now = Date.now();
  const running = new Set<string>(
    Array.from(last.values())
      .filter((a) => a.status === "started" && now - new Date(a.ts).getTime() < STALE_MS)
      .map((a) => a.role),
  );
  const latest = [...activity].reverse().find((a) => a.status !== "started");
  const runningRole = [...activity].reverse().find((a) => running.has(a.role))?.role;
  const extra = runningRole && !PIPELINE.includes(runningRole as AgentRole) ? runningRole : null;
  const roles = extra ? [...PIPELINE, extra as AgentRole] : PIPELINE;

  const summary = runningRole
    ? last.get(runningRole)?.summary || `${agentInfo(runningRole).name} is working…`
    : latest
      ? latest.summary
      : idle;
  const summaryWho = runningRole ? agentInfo(runningRole).name : latest ? agentInfo(latest.role).name : null;

  return (
    <section className="agent-strip" aria-label="AI at work">
      <span className="agent-strip-label">
        <Sparkles size={16} aria-hidden="true" />
        AI at work
      </span>
      <ol className="agent-pipeline">
        {roles.map((role, i) => {
          const info = agentInfo(role);
          const Icon = info.icon;
          const isRunning = running.has(role);
          const state = isRunning ? "running" : last.get(role)?.status === "failed" ? "failed" : last.has(role) ? "done" : "idle";
          return (
            <Fragment key={role}>
              {i > 0 && <ChevronRight size={14} aria-hidden="true" className="agent-sep" />}
              <li className={`agent-chip agent-${state}`} title={info.job} aria-current={isRunning ? "step" : undefined}>
                <Icon size={16} aria-hidden="true" />
                <span className="agent-chip-name">{info.name}</span>
                {isRunning && <span className="sr-only"> (working)</span>}
              </li>
            </Fragment>
          );
        })}
      </ol>
      <p className="agent-summary" aria-live="polite">
        {summaryWho && <strong>{summaryWho}: </strong>}
        {summary}
      </p>
    </section>
  );
}
