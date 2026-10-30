import type { RiskLevel, RiskScore } from "../api/types";

const LEVEL_LABEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High", extreme: "Extreme" };

function levelFor(score: number): RiskLevel {
  if (score >= 20) return "extreme";
  if (score >= 10) return "high";
  if (score >= 5) return "medium";
  return "low";
}

/** Coloured risk level with its matrix score (likelihood × consequence in the tooltip). */
export function RiskChip({ risk }: { risk: RiskScore | undefined }) {
  if (!risk) return <span className="muted">—</span>;
  return (
    <span
      className={`risk-chip risk-${risk.level}`}
      title={`Likelihood ${risk.likelihood} × consequence ${risk.consequence} = ${risk.score}`}
    >
      {LEVEL_LABEL[risk.level]}
      <span className="risk-score">{risk.score}</span>
    </span>
  );
}

const CONSEQUENCE = ["Insignificant", "Minor", "Moderate", "Major", "Catastrophic"];
const LIKELIHOOD = ["Rare", "Unlikely", "Possible", "Likely", "Almost certain"];

/** The 5×5 matrix the scores come from, small enough to sit under the hazard table. */
export function RiskLegend() {
  return (
    <figure className="risk-legend" aria-label="Risk matrix legend">
      <table className="risk-matrix">
        <caption className="sr-only">Risk score is likelihood times consequence</caption>
        <thead>
          <tr>
            <th scope="col" className="rm-corner">
              L \ C
            </th>
            {CONSEQUENCE.map((c, i) => (
              <th key={c} scope="col" title={c}>
                {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[5, 4, 3, 2, 1].map((l) => (
            <tr key={l}>
              <th scope="row" title={LIKELIHOOD[l - 1]}>
                {l}
              </th>
              {[1, 2, 3, 4, 5].map((c) => (
                <td key={c} className={`rm-cell risk-${levelFor(l * c)}`}>
                  {l * c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption>
        <span className="risk-key">
          {(["low", "medium", "high", "extreme"] as RiskLevel[]).map((lv) => (
            <span key={lv} className={`risk-chip risk-${lv}`}>
              {LEVEL_LABEL[lv]}
            </span>
          ))}
        </span>
        <span className="muted small">
          Likelihood (1 rare – 5 almost certain) × consequence (1 insignificant – 5 catastrophic). Risk after
          controls applies the best confirmed control in the hierarchy of controls.
        </span>
      </figcaption>
    </figure>
  );
}
