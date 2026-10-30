import { useQuery } from "@tanstack/react-query";
import { CircleX } from "lucide-react";
import { STEP_LABEL, agentInfo, isLlm, providerLabel } from "../agents/agents";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import type { AgentStep, AuditEntry } from "../api/types";
import { EmptyState, InlineError, Skeleton } from "../components/Feedback";
import { formatTime } from "../format";

interface Run {
  id: string;
  ts: string;
  role: string;
  status: string;
  step: string;
  tick: number | null;
  summary: string;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  error: string | null;
}

interface Group {
  key: string;
  step: string;
  tick: number | null;
  runs: Run[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toRun(e: AuditEntry): Run {
  const d = e.details ?? {};
  return {
    id: e.id,
    ts: e.ts,
    role: str(d.role) ?? "agent",
    status: str(d.status) ?? (d.error ? "failed" : "done"),
    step: str(d.step) ?? "live",
    tick: num(d.tick),
    summary: str(d.summary) ?? "",
    provider: str(d.provider),
    model: e.model,
    promptVersion: e.prompt_version,
    latencyMs: num(d.latency_ms),
    error: str(d.error),
  };
}

/** Consecutive runs from the same step and tick form one group. */
function groupRuns(runs: Run[]): Group[] {
  const groups: Group[] = [];
  for (const r of runs) {
    const key = `${r.step}:${r.tick ?? ""}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.runs.push(r);
    else groups.push({ key, step: r.step, tick: r.tick, runs: [r] });
  }
  return groups;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "How CrewBrief built this form": every agent run from the audit log, grouped by pass. */
export function AgentTimeline({ sessionId }: { sessionId: string }) {
  const audit = useQuery({ queryKey: qk.audit(sessionId), queryFn: () => api.audit(sessionId) });

  return (
    <div className="agent-timeline">
      <p className="explainer">
        A deterministic orchestrator runs specialist AI agents while the crew talks. Each agent does one job and hands
        its result to the next. Rules in code check every change before it reaches the form, and a person reviews and
        signs it.
      </p>
      {audit.isPending && <Skeleton lines={6} height={40} />}
      {audit.isError && <InlineError error={audit.error} onRetry={() => void audit.refetch()} />}
      {audit.data && <Timeline entries={audit.data} />}
    </div>
  );
}

function Timeline({ entries }: { entries: AuditEntry[] }) {
  const runs = entries
    .filter((e) => e.action === "role.invoked")
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map(toRun);
  if (runs.length === 0) return <EmptyState title="No agent runs recorded yet" />;

  const groups = groupRuns(runs);
  const failed = runs.filter((r) => r.status === "failed").length;
  const llm = runs.some((r) => isLlm(r.provider));

  return (
    <>
      <p className="timeline-meta tnum">
        {runs.length} agent runs in {groups.length} passes
        {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
        {!llm && <span> · rule-based stand-ins (offline)</span>}
      </p>
      <ol className="timeline">
        {groups.map((g) => (
          <li key={`${g.key}-${g.runs[0].id}`} className="timeline-group">
            <h3 className="timeline-group-head">
              <span>{STEP_LABEL[g.step as AgentStep] ?? g.step}</span>
              {g.tick !== null && <span className="muted tnum">Pass {g.tick}</span>}
              <span className="muted tnum timeline-time">{formatTime(g.runs[0].ts)}</span>
            </h3>
            <ol className="timeline-runs">
              {g.runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </>
  );
}

function RunRow({ run }: { run: Run }) {
  const info = agentInfo(run.role);
  const failed = run.status === "failed";
  const Icon = failed ? CircleX : info.icon;
  return (
    <li className={`run${failed ? " run-failed" : ""}`}>
      <span className="run-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="run-body">
        <div className="run-head">
          <strong>{info.name}</strong>
          {failed && <span className="status gap-blocking">Failed</span>}
          <span className="run-latency tnum">{formatLatency(run.latencyMs)}</span>
        </div>
        {run.summary && <p className="run-summary">{run.summary}</p>}
        {failed && run.error && <p className="run-error">{run.error}</p>}
        <div className="run-meta">
          <span className={`provider${isLlm(run.provider) ? " provider-llm" : ""}`}>{providerLabel(run.provider, run.model)}</span>
          {run.promptVersion && <span className="muted mono">{run.promptVersion}</span>}
        </div>
      </div>
    </li>
  );
}
