import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import { useLibraryIndex, useUserDirectory } from "../api/queries";
import type {
  ControlStatus,
  FieldValue,
  Form,
  HazardStatus,
  TranscriptSegment,
} from "../api/types";
import { SeverityBadge } from "../components/Feedback";
import { formatOffset, guestLabel } from "../format";
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
  // The crew sees what they actually said; library suggestions stay with the supervisor.
  const stated = (h: (typeof hazards)[number]) => Object.values(h.controls).filter((c) => c.status !== "proposed");
  const controls = hazards.reduce((n, h) => n + stated(h).length, 0);
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
      <section className="cf-section" aria-label="Hazards and controls">
        <h3>
          Hazards &amp; controls
          <span className="cf-count" aria-live="polite">
            {hazards.length} · {controls} {controls === 1 ? "control" : "controls"}
          </span>
        </h3>
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
                  <span className={`muted small status-${h.status}`}>{HAZARD_STATUS[h.status]}</span>
                </span>
              </div>
              {stated(h).length ? (
                <ul className="chip-list">
                  {stated(h).map((c) => (
                    <li key={c.code} className={`chip cf-control control-${c.status}`} title={c.description}>
                      <Check size={14} aria-hidden="true" className="ok-text" />
                      {c.name} <span className="muted">· {CONTROL_STATUS[c.status]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                h.status !== "not_present" && <p className="warn-text small">No control stated yet</p>
              )}
              {Object.keys(h.controls).length > stated(h).length && (
                <p className="muted small">
                  {Object.keys(h.controls).length - stated(h).length} more suggested by the hazard library
                </p>
              )}
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
          <h3>
            Emergency
            <span className="cf-count">{emergency.filter(([, v]) => v).length} of 4</span>
          </h3>
          <dl className="cf-fields">
            {emergency.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className={value ? "" : "placeholder"}>
                  {value ?? "Not heard yet"}
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

/** The last few transcript lines; filtered (off-topic, low confidence) lines are greyed. */
export function TranscriptTail({ segments }: { segments: TranscriptSegment[] }) {
  const users = useUserDirectory();
  const tail = segments.slice(-8);
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
                  ? "CrewBrief"
                  : (s.speaker_name ?? (s.user_id ? users.get(s.user_id)?.name : undefined) ?? guestLabel(s.speaker_id))}
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
