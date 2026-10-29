import { useEffect, useRef } from "react";
import { useLibraryIndex } from "../api/queries";
import type {
  ControlStatus,
  FieldValue,
  Form,
  Gap,
  HazardStatus,
  TranscriptSegment,
} from "../api/types";
import { GapSeverityBadge, SeverityBadge } from "../components/Feedback";
import { formatOffset } from "../format";
import { ConfidenceMeter } from "../session/Provenance";
import { sortHazards } from "../session/Hazards";

const HAZARD_STATUS: Record<HazardStatus, string> = {
  present: "Present",
  unconfirmed: "To confirm",
  not_present: "Not present",
};
const CONTROL_STATUS: Record<ControlStatus, string> = {
  proposed: "Proposed",
  planned: "Planned",
  in_place: "In place",
};

function text(field: FieldValue | null | undefined): string | null {
  if (
    !field ||
    field.value === null ||
    field.value === undefined ||
    field.value === ""
  )
    return null;
  return typeof field.value === "string" ? field.value : String(field.value);
}

/** Read-only summary of the draft form for the crew, filling in as events arrive. */
export function CrewForm({ form, live }: { form: Form; live?: boolean }) {
  const { taskTypeName } = useLibraryIndex();
  const hazards = sortHazards(Object.values(form.hazards));
  const controls = hazards.reduce(
    (n, h) => n + Object.keys(h.controls).length,
    0,
  );
  const taskType = text(form.job.task_type);
  const job: [string, string | null][] = [
    ["Job", text(form.job.title)],
    ["Task", taskType ? taskTypeName(taskType) : null],
    ["Location", text(form.job.location)],
    ["Work order", text(form.job.work_order_id)],
  ];
  const emergency: [string, string | null][] = [
    ["Muster point", text(form.emergency.muster_point)],
    ["Nearest hospital", text(form.emergency.nearest_hospital)],
    ["First aider", text(form.emergency.first_aider)],
    ["Comms", text(form.emergency.communications)],
  ];
  const ppe = Object.values(form.ppe);

  return (
    <div className="crew-form-summary">
      <div className="form-counters" aria-live="polite">
        <span>
          <strong>{hazards.length}</strong> hazards
        </span>
        <span>
          <strong>{controls}</strong> controls
        </span>
        <span>
          <strong>{emergency.filter(([, v]) => v).length}/4</strong> emergency
        </span>
      </div>

      <section className="cf-section" aria-label="Hazards and controls">
        <h3>Hazards &amp; controls</h3>
        {hazards.length === 0 && (
          <p className="muted placeholder-line">
            {live ? "Listening for hazards…" : "No hazards recorded."}
          </p>
        )}
        <ul className="cf-hazards">
          {hazards.map((h) => (
            <li
              key={h.code}
              className={`cf-hazard sev-border-${h.severity} hazard-${h.status}`}
            >
              <div className="cf-hazard-head">
                <strong>{h.name}</strong>
                <span className="cf-hazard-badges">
                  <SeverityBadge severity={h.severity} />
                  <span className={`badge badge-outline status-${h.status}`}>
                    {HAZARD_STATUS[h.status]}
                  </span>
                </span>
              </div>
              {Object.keys(h.controls).length ? (
                <ul className="chip-list">
                  {Object.values(h.controls).map((c) => (
                    <li
                      key={c.code}
                      className={`chip cf-control control-${c.status}`}
                      title={c.description}
                    >
                      ✓ {c.name}{" "}
                      <span className="muted">
                        · {CONTROL_STATUS[c.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                h.status !== "not_present" && (
                  <p className="warn-text small">No control yet</p>
                )
              )}
              <ConfidenceMeter value={h.provenance.confidence} />
            </li>
          ))}
        </ul>
      </section>

      <div className="cf-two">
        <section className="cf-section" aria-label="Job details">
          <h3>Job</h3>
          <dl className="cf-fields">
            {job.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className={value ? "" : "placeholder"}>{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="cf-section" aria-label="Emergency plan">
          <h3>Emergency</h3>
          <dl className="cf-fields">
            {emergency.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className={value ? "" : "placeholder"}>
                  {value ?? "Not yet heard"}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      {ppe.length > 0 && (
        <section className="cf-section" aria-label="PPE">
          <h3>PPE</h3>
          <ul className="chip-list">
            {ppe.map((p) => (
              <li key={p.code} className="chip">
                {p.name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Open gaps, blocking first. */
export function CrewGaps({
  gaps,
  title = "Open questions",
}: {
  gaps: Gap[];
  title?: string;
}) {
  const rank = { blocking: 0, warning: 1, info: 2 } as const;
  const open = gaps
    .filter((g) => g.status === "open")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  return (
    <section className="card crew-card" aria-labelledby="gaps-title">
      <h2 id="gaps-title">
        {title} <span className="count">{open.length}</span>
      </h2>
      {open.length === 0 ? (
        <p className="ok-text">✓ Nothing outstanding</p>
      ) : (
        <ul className="cf-gaps">
          {open.map((g) => (
            <li key={g.id} className={`cf-gap gap-card-${g.severity}`}>
              <GapSeverityBadge severity={g.severity} />
              <span>{g.question ?? g.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The last few transcript lines; filtered (off-topic, low confidence) lines are greyed. */
export function TranscriptTail({
  segments,
  nameOf,
}: {
  segments: TranscriptSegment[];
  nameOf: (id: string | null) => string;
}) {
  const tail = segments.slice(-12);
  const list = useRef<HTMLOListElement>(null);
  const lastId = tail[tail.length - 1]?.id;
  // Keep the newest line in view inside the list, without scrolling the page.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [lastId]);
  return (
    <ol className="tail" aria-live="polite" ref={list}>
      {tail.length === 0 && <li className="muted">Nothing heard yet.</li>}
      {tail.map((s) => {
        const prompt = s.source === "voice_prompt";
        const filtered = s.filtered && !prompt;
        return (
          <li
            key={s.id}
            className={`tail-line${filtered ? " tail-filtered" : ""}${prompt ? " tail-prompt" : ""}`}
            title={filtered ? (s.filter_reason ?? "Ignored") : undefined}
          >
            <span className="tail-meta">
              <strong>
                {prompt
                  ? "CrewBrief asked"
                  : (s.speaker_name ?? nameOf(s.user_id))}
              </strong>
              <span className="muted">{formatOffset(s.start_ms)}</span>
            </span>
            <span>{s.text}</span>
            {filtered && (
              <span className="tail-reason">
                Ignored: {s.filter_reason ?? "off-topic"}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
