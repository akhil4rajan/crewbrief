import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, InlineError, Skeleton } from "../components/Feedback";
import { formatPercent, humanize } from "../format";

interface Row {
  label: string;
  ai_filled: number;
  edited: number;
  edit_rate: number;
  added_by_human?: number;
}

export function MetricsPage() {
  const { hasRole } = useAuth();
  const metrics = useQuery({ queryKey: qk.editRate, queryFn: api.editRate, enabled: hasRole("supervisor", "safety_admin") });

  if (!hasRole("supervisor", "safety_admin")) {
    return (
      <div className="page">
        <EmptyState title="Not available">The accuracy dashboard is for supervisors and safety admins.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>AI accuracy</h1>
          <p className="muted small">
            Share of AI-filled values a person changed before sign-off. Lower is better; a rising rate on a field points at a prompt or
            library gap.
          </p>
        </div>
      </div>
      {metrics.isPending && <Skeleton lines={8} height={24} />}
      {metrics.isError && <InlineError error={metrics.error} onRetry={() => void metrics.refetch()} />}
      {metrics.data && (
        <>
          <div className="stat-row">
            <Stat label="Sessions analysed" value={String(metrics.data.sessions)} />
            <Stat label="AI-filled values" value={String(metrics.data.fields.reduce((n, f) => n + f.ai_filled, 0))} />
            <Stat
              label="Overall edit rate"
              value={(() => {
                const filled = metrics.data.fields.reduce((n, f) => n + f.ai_filled, 0);
                const edited = metrics.data.fields.reduce((n, f) => n + f.edited, 0);
                return filled ? formatPercent(edited / filled, 1) : "—";
              })()}
            />
          </div>
          <RateSection
            title="By field"
            caption="Edit rate per form field pattern"
            keyLabel="Field pattern"
            mono
            rows={metrics.data.fields.map((f) => ({ ...f, label: f.path_pattern }))}
          />
          <RateSection
            title="By role"
            caption="Edit rate per AI role that produced the value"
            keyLabel="Role"
            rows={metrics.data.roles.map((r) => ({ ...r, label: humanize(r.role) }))}
          />
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function RateSection({ title, caption, keyLabel, rows, mono }: { title: string; caption: string; keyLabel: string; rows: Row[]; mono?: boolean }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const sorted = [...rows].sort((a, b) => b.edit_rate - a.edit_rate || b.ai_filled - a.ai_filled);
  const showAdded = rows.some((r) => r.added_by_human !== undefined);
  return (
    <section className="card metric-card" aria-labelledby={`m-${title}`}>
      <header className="pane-head">
        <h2 id={`m-${title}`}>{title}</h2>
        <div className="segmented" role="group" aria-label={`${title} view`}>
          <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </div>
      </header>
      {sorted.length === 0 ? (
        <EmptyState title="No data yet">Edit rates appear once briefings have been signed off.</EmptyState>
      ) : view === "chart" ? (
        <BarChart rows={sorted} caption={caption} mono={mono} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{keyLabel}</th>
                <th scope="col" className="num">
                  AI-filled
                </th>
                <th scope="col" className="num">
                  Edited
                </th>
                <th scope="col" className="num">
                  Edit rate
                </th>
                {showAdded && (
                  <th scope="col" className="num" title="Values the AI missed that a person added">
                    Added by people
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.label}>
                  <td className={mono ? "mono small" : undefined}>{r.label}</td>
                  <td className="num">{r.ai_filled}</td>
                  <td className="num">{r.edited}</td>
                  <td className="num">{formatPercent(r.edit_rate, 1)}</td>
                  {showAdded && <td className="num">{r.added_by_human ?? 0}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const BAR_H = 18;
const ROW_GAP = 10;
const LABEL_W = 230;
const VALUE_W = 64;
const WIDTH = 760;

/** Horizontal bar chart, one hue (magnitude), scale fixed at 0–100% so charts compare across visits. */
function BarChart({ rows, caption, mono }: { rows: Row[]; caption: string; mono?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotW = WIDTH - LABEL_W - VALUE_W;
  const height = rows.length * (BAR_H + ROW_GAP) + 24;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={`${caption}. Switch to table view for exact values.`} className="bar-chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={LABEL_W + t * plotW} x2={LABEL_W + t * plotW} y1={0} y2={height - 20} className="grid" />
            <text x={LABEL_W + t * plotW} y={height - 6} className="axis" textAnchor="middle">
              {formatPercent(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = i * (BAR_H + ROW_GAP) + 4;
          const w = Math.max(r.edit_rate * plotW, r.edit_rate > 0 ? 3 : 0);
          const active = hover === i;
          return (
            <g
              key={r.label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className={active ? "bar-row is-active" : "bar-row"}
            >
              <title>{`${r.label}: ${formatPercent(r.edit_rate, 1)} edited (${r.edited} of ${r.ai_filled} AI-filled values)`}</title>
              <rect x={0} y={y - ROW_GAP / 2} width={WIDTH} height={BAR_H + ROW_GAP} className="hit" />
              <text x={LABEL_W - 10} y={y + BAR_H / 2} className={mono ? "label mono" : "label"} textAnchor="end" dominantBaseline="central">
                {r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label}
              </text>
              <rect x={LABEL_W} y={y} width={plotW} height={BAR_H} rx={4} className="track" />
              {w > 0 && <rect x={LABEL_W} y={y} width={w} height={BAR_H} rx={4} className="bar" />}
              <text x={LABEL_W + plotW + 8} y={y + BAR_H / 2} className="value" dominantBaseline="central">
                {formatPercent(r.edit_rate)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover] && (
        <figcaption className="chart-tip" aria-live="polite">
          <strong>{rows[hover].label}</strong> — {formatPercent(rows[hover].edit_rate, 1)} edited ({rows[hover].edited} of {rows[hover].ai_filled}{" "}
          AI-filled)
        </figcaption>
      )}
    </figure>
  );
}
