import { useState, type ReactNode } from "react";
import { pointer } from "../api/jsonPointer";
import { useLibraryIndex, useUserDirectory } from "../api/queries";
import type { CrewEntry, Form } from "../api/types";
import { EmptyState } from "../components/Feedback";
import { formatTime, humanize } from "../format";
import { FieldRow } from "./FieldRow";
import { AddHazardDialog, HazardCard, sortHazards } from "./Hazards";
import { ProvenanceMeta } from "./Provenance";
import { useSessionUi } from "./SessionContext";

function Section({ id, title, path, count, action, children }: {
  id: string;
  title: string;
  path: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="form-section" aria-labelledby={id} data-path={path} tabIndex={-1}>
      <header className="form-section-head">
        <h3 id={id}>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}

export function FormPane({ presence }: { presence: CrewEntry[] | null }) {
  const { detail, edit } = useSessionUi();
  const form: Form = detail.draft.form;
  const { library, taskTypeName } = useLibraryIndex();
  const [addingHazard, setAddingHazard] = useState(false);

  const hazards = sortHazards(Object.values(form.hazards));
  const present = hazards.filter((h) => h.status === "present").length;
  const taskOptions = (library?.task_types ?? []).map((t) => ({ value: t.code, label: `${t.name} (${t.code})` }));

  return (
    <div className="form-pane">
      <Section id="sec-job" title="Job" path="/job">
        <FieldRow label="Title" path="/job/title" field={form.job.title} />
        <FieldRow label="Work order" path="/job/work_order_id" field={form.job.work_order_id} />
        <FieldRow
          label="Task type"
          path="/job/task_type"
          field={form.job.task_type}
          options={taskOptions}
          display={(v) => taskTypeName(String(v))}
        />
        <FieldRow label="Location" path="/job/location" field={form.job.location} />
        <FieldRow label="Description" path="/job/description" field={form.job.description} multiline />
        <FieldRow label="Scheduled start" path="/job/scheduled_start" field={form.job.scheduled_start} />
      </Section>

      <CrewSection form={form} presence={presence} />

      <Section id="sec-tasks" title="Tasks" path="/tasks" count={Object.keys(form.tasks).length}>
        {Object.keys(form.tasks).length === 0 ? (
          <p className="muted small">No task steps captured yet.</p>
        ) : (
          <ol className="item-list">
            {Object.values(form.tasks)
              .sort((a, b) => a.order - b.order)
              .map((t) => (
                <li key={t.id} data-path={pointer("tasks", t.id)} tabIndex={-1}>
                  <span>{t.description}</span>
                  <ProvenanceMeta provenance={t.provenance} compact />
                </li>
              ))}
          </ol>
        )}
      </Section>

      <Section id="sec-site" title="Site conditions" path="/site_conditions" count={Object.keys(form.site_conditions).length}>
        {Object.keys(form.site_conditions).length === 0 ? (
          <p className="muted small">No site conditions captured yet.</p>
        ) : (
          <ul className="item-list">
            {Object.values(form.site_conditions).map((c) => (
              <li key={c.id} data-path={pointer("site_conditions", c.id)} tabIndex={-1}>
                <span>
                  {c.description}
                  {c.code && <span className="muted small mono"> {c.code}</span>}
                </span>
                <ProvenanceMeta provenance={c.provenance} compact />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="sec-hazards"
        title="Hazards"
        path="/hazards"
        count={hazards.length}
        action={
          edit.allowed && (
            <button type="button" className="btn btn-small" onClick={() => setAddingHazard(true)}>
              + Add hazard
            </button>
          )
        }
      >
        {hazards.length === 0 ? (
          <EmptyState title="No hazards yet">Hazards appear here as the crew talks through the job.</EmptyState>
        ) : (
          <>
            <p className="muted small">
              {present} present · {hazards.length - present} unconfirmed or not present
            </p>
            <div className="hazard-list">
              {hazards.map((h) => (
                <HazardCard key={h.code} hazard={h} />
              ))}
            </div>
          </>
        )}
      </Section>

      <Section id="sec-ppe" title="PPE" path="/ppe" count={Object.keys(form.ppe).length}>
        {Object.keys(form.ppe).length === 0 ? (
          <p className="muted small">No PPE recorded.</p>
        ) : (
          <ul className="chip-list">
            {Object.values(form.ppe).map((p) => (
              <li key={p.code} className="chip" data-path={pointer("ppe", p.code)} tabIndex={-1}>
                <span>{p.name}</span>
                <ProvenanceMeta provenance={p.provenance} compact />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="sec-emergency" title="Emergency" path="/emergency">
        <FieldRow label="Muster point" path="/emergency/muster_point" field={form.emergency.muster_point} />
        <FieldRow label="Nearest hospital" path="/emergency/nearest_hospital" field={form.emergency.nearest_hospital} />
        <FieldRow label="First aider" path="/emergency/first_aider" field={form.emergency.first_aider} />
        <FieldRow label="Communications" path="/emergency/communications" field={form.emergency.communications} />
      </Section>

      <Section id="sec-permits" title="Permits" path="/permits" count={Object.keys(form.permits).length}>
        {Object.keys(form.permits).length === 0 ? (
          <p className="muted small">No permits referenced.</p>
        ) : (
          <ul className="item-list">
            {Object.values(form.permits).map((p) => (
              <li key={p.id} data-path={pointer("permits", p.id)} tabIndex={-1}>
                <span>
                  {humanize(p.type)} {p.reference && <span className="mono">{p.reference}</span>}
                </span>
                <ProvenanceMeta provenance={p.provenance} compact />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="sec-notes" title="Notes" path="/notes">
        <FieldRow label="Notes" path="/notes" field={form.notes} multiline />
      </Section>

      {addingHazard && <AddHazardDialog existing={form.hazards} onClose={() => setAddingHazard(false)} />}
    </div>
  );
}

function CrewSection({ form, presence }: { form: Form; presence: CrewEntry[] | null }) {
  const { detail } = useSessionUi();
  const users = useUserDirectory();
  const onForm = form.crew;
  const live = new Map((presence ?? []).map((c) => [c.user_id, c]));
  const ids = Array.from(new Set([...detail.session.crew_member_ids, ...Object.keys(onForm), ...live.keys()]));

  return (
    <Section id="sec-crew" title="Crew & check-in" path="/crew" count={ids.length}>
      {ids.length === 0 ? (
        <p className="muted small">No crew assigned.</p>
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Checked in</th>
              <th scope="col">Acknowledged</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const entry = live.get(id) ?? onForm[id];
              return (
                <tr key={id} data-path={pointer("crew", id)} tabIndex={-1}>
                  <td>{entry?.name ?? users.get(id)?.name ?? id}</td>
                  <td>{humanize(entry?.role ?? "crew")}</td>
                  <td>
                    {entry?.checked_in_at ? (
                      <span className="ok-text">✓ {formatTime(entry.checked_in_at)}</span>
                    ) : (
                      <span className="muted">Not checked in</span>
                    )}
                  </td>
                  <td>{entry?.acknowledged ? <span className="ok-text">✓ Yes</span> : <span className="muted">No</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}
